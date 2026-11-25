import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  channelDefById,
  decryptDingtalkEvent,
  decryptFeishuEncrypt,
  normalizeChannelId,
  parseDingtalkEventPayload,
  parseDingtalkRobotBody,
  parseFeishuEvent,
  parseWechatXml,
  publicCatalog,
  FOLDER_ERROR,
  sendChannelMessage,
  dingtalkCallbackReply,
  signDingtalkEvent,
  signWechatCallback,
  timingSafeEquals,
  validateChannelValues,
  verifyDingtalkRobotSignature,
  verifyFeishuEventSignature,
  type ChannelId,
  type InboundEvent,
} from "@huoye/connectors";
import {
  ConfirmationError,
  applyFieldReplacements,
  estimateTokens,
  extractMemoryUpdate,
  modelErrorMessage,
  normalizeSchedule,
  ScheduleError,
  type FieldReplacement,
  type ModelProvider,
} from "@huoye/core";
import {
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryPathError,
  MemoryPermissionError,
  bodyWithProvenance,
  extractTodos,
  humanMemoryBody,
  toggleTodoAt,
  zipMemoryTree,
  type NoteScope,
} from "@huoye/memory";
import { listUsageEvents, recordUsageEvent, summarizeUsage } from "@huoye/metering";
import { nowIso, formatIso, type ConfirmationRequest } from "@huoye/schema";
import { listAudit } from "@huoye/core";
import {
  addMessage,
  addRunEvent,
  createChat,
  createTask,
  getChat,
  getTask,
  listChats,
  listMessages,
  listRunEvents,
  listTasks,
  reapStaleRunningTasks,
  saveTask,
  touchChat,
} from "./records";
import { buildChatPrompt } from "./prompt";
import { openWorkspace, type Workspace } from "./workspace";
import { generateAndSaveBrief, latestBriefPayload } from "./generate-brief";
import { readAboutYouFiles, unitCost, dateInZone } from "./helpers";
import {
  healthNotesPayload,
  readRecordingAudio,
  recordingsPayload,
  RecordingError,
  saveUploadedRecording,
  todayCardsPayload,
  toRecordingItem,
} from "./recordings";
import { executeTaskRun, TaskRunError } from "./run-task";
import { startScheduler, tickDueWork } from "./scheduler";
import {
  acknowledgeNotifications,
  markProactiveRead,
  notifyPendingConfirmation,
  pendingNotifications,
  proactiveStateView,
  resumeProactive,
} from "./proactive";
import {
  createNote,
  createNoteFromChat,
  defaultNoteTitle,
  ensureNoteDirs,
  memoryHrefFor,
  noteDetail,
  notesPayload,
  saveNote,
} from "./notes";
import {
  TRANSCRIPT_SOURCE_LABELS,
  attachTodoProvenance,
  parseTranscript,
  requestMeetingTodoConfirmations,
  summarizeMeeting,
  writeMeetingNote,
  type TranscriptSource,
} from "./meetings";

export interface CreateAppOptions {
  home?: string;
  workspace?: Workspace;
  now?: () => Date;
  /** 测试时可以注入假的 fetch，避免打到公网。 */
  fetchImpl?: typeof fetch;
}

export function createApp(options: CreateAppOptions = {}) {
  const workspace =
    options.workspace ?? openWorkspace(options.home, { fetchImpl: options.fetchImpl, now: options.now });
  const clock = options.now ?? (() => new Date());
  const app = new Hono();
  ensureNoteDirs(workspace);

  app.get("/api/health", (c) => c.json({ ok: true, name: "huoye" }));

  app.get("/api/workspace", (c) =>
    c.json({
      home: workspace.home,
      memory: workspace.paths.memory,
      config: workspace.paths.config,
    }),
  );

  app.get("/api/settings", (c) => c.json(workspace.readSettings()));

  app.put("/api/settings", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const next = workspace.writeSettings(body);
      workspace.audit({ actor: "user", type: "settings.update", summary: "更新设置" });
      return c.json(next);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "无法保存设置" }, 400);
    }
  });

  app.put("/api/settings/providers/:id/key", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { key?: string };
    const key = body.key ?? "";
    try {
      workspace.setProviderKey(c.req.param("id"), key);
      workspace.audit({
        actor: "user",
        type: "settings.provider_key",
        summary: key ? "已保存模型密钥" : "已清除模型密钥",
        refs: [c.req.param("id")],
      });
      return c.json(workspace.readSettings());
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "无法保存密钥" }, 400);
    }
  });

  app.delete("/api/settings/providers/:id", (c) => {
    try {
      const next = workspace.removeProvider(c.req.param("id"));
      workspace.audit({
        actor: "user",
        type: "settings.provider_remove",
        summary: "删除模型供应商",
        refs: [c.req.param("id")],
      });
      return c.json(next);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "无法删除供应商" }, 400);
    }
  });

  app.get("/api/connectors", (c) => c.json({ items: publicCatalog(workspace.folders) }));

  app.post("/api/connectors/local-folders", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    const folderPath = typeof body.path === "string" ? body.path : "";
    if (!folderPath.trim()) return c.json({ error: FOLDER_ERROR.empty }, 400);
    try {
      const roots = workspace.folders.add(folderPath);
      workspace.audit({ actor: "user", type: "connector.local.add", summary: `添加本地文件夹 ${folderPath}` });
      return c.json({ roots, folders: workspace.folders.inspect() });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "无法添加" }, 400);
    }
  });

  app.get("/api/connectors/local-folders/listing", (c) => {
    const folderPath = c.req.query("path") ?? "";
    if (!folderPath.trim()) return c.json({ error: FOLDER_ERROR.empty }, 400);
    try {
      return c.json(workspace.folders.listing(folderPath));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "无法列出内容" }, 400);
    }
  });

  app.delete("/api/connectors/local-folders", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    const folderPath = typeof body.path === "string" ? body.path : "";
    if (!folderPath.trim()) return c.json({ error: FOLDER_ERROR.empty }, 400);
    try {
      const roots = workspace.folders.remove(folderPath);
      workspace.audit({ actor: "user", type: "connector.local.remove", summary: `移除本地文件夹 ${folderPath}` });
      return c.json({ roots, folders: workspace.folders.inspect() });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "无法移除" }, 400);
    }
  });

  /* ------------------------------- 聊天通道 ------------------------------- */

  app.get("/api/channels", (c) => c.json({ items: workspace.channels.list() }));

  app.get("/api/channels/:id", (c) => {
    const view = workspace.channels.view(c.req.param("id"));
    if (!view) return c.json({ error: "没有这个通道。" }, 404);
    return c.json(view);
  });

  app.put("/api/channels/:id", async (c) => {
    const def = channelDefById(c.req.param("id"));
    if (!def) return c.json({ error: "没有这个通道。" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const existing = workspace.channels.values(def.id);
    const merged: Record<string, unknown> = {};
    for (const field of def.fields) {
      if (!(field.key in body)) {
        // 没带的字段保持原样（密钥不回显，不能被空值覆盖）。
        merged[field.key] = existing[field.key] ?? "";
        continue;
      }
      merged[field.key] = typeof body[field.key] === "string" ? body[field.key] : "";
    }
    const result = validateChannelValues(def, merged);
    if (!result.ok) {
      return c.json({ error: result.error ?? "还没有填完必填项，通道仍是未连接。" }, 400);
    }
    workspace.channels.save(def.id, result.values);
    workspace.audit({
      actor: "user",
      type: "connector.channel.save",
      summary: `保存${def.name}通道凭证`,
      refs: [def.id],
    });
    return c.json(workspace.channels.view(def.id));
  });

  app.delete("/api/channels/:id", (c) => {
    const def = channelDefById(c.req.param("id"));
    if (!def) return c.json({ error: "没有这个通道。" }, 404);
    workspace.channels.remove(def.id);
    workspace.audit({
      actor: "user",
      type: "connector.channel.remove",
      summary: `移除${def.name}通道凭证`,
      refs: [def.id],
    });
    return c.json(workspace.channels.view(def.id));
  });

  app.post("/api/channels/feishu/event", (c) => handleLarkStyleEvent(c, "feishu"));
  app.post("/api/channels/lark/event", (c) => handleLarkStyleEvent(c, "lark"));
  app.post("/api/channels/dingtalk/event", (c) => handleDingtalkEvent(c));
  app.get("/api/channels/wechat/event", (c) => handleWechatVerification(c));
  app.post("/api/channels/wechat/event", (c) => handleWechatMessage(c));
  app.get("/api/channels/weixin/event", (c) => handleWechatVerification(c));
  app.post("/api/channels/weixin/event", (c) => handleWechatMessage(c));

  app.post("/api/channels/:id/simulate", async (c) => {
    const def = channelDefById(c.req.param("id"));
    if (!def) return c.json({ error: "没有这个通道。" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { text?: string; senderLabel?: string };
    const text = (body.text ?? "").trim();
    if (!text) return c.json({ error: "缺少要模拟的内容。" }, 400);
    const event: InboundEvent = {
      text,
      senderLabel: body.senderLabel?.trim() || "模拟器",
      sourceRef: `channel:${def.id}/simulator`,
    };
    await landInbound(def.id, event, { simulator: true });
    return c.json({ ok: true, status: workspace.channels.status(def.id) }, 201);
  });

  app.get("/api/memory/tree", (c) => c.json({ tree: workspace.memory.listTree() }));

  app.get("/api/memory/folder", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "缺少 path" }, 400);
    try {
      return c.json(workspace.memory.listFolder(path));
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.get("/api/memory/about-you", (c) => {
    const composed = workspace.memory.composeAboutYou();
    return c.json(composed);
  });

  app.get("/api/memory/file", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "缺少 path" }, 400);
    try {
      return c.json(workspace.memory.readFile(path));
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.put("/api/memory/file", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "缺少 path" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; expectedRevision?: string };
    if (typeof body.content !== "string") return c.json({ error: "缺少 content" }, 400);
    if (typeof body.expectedRevision !== "string") {
      return c.json({ error: "保存必须带 expectedRevision" }, 400);
    }
    try {
      const file = workspace.memory.writeFile(path, body.content, body.expectedRevision, "owner");
      workspace.audit({
        actor: "user",
        type: "memory.write",
        summary: `保存 ${path}`,
        refs: [path],
      });
      return c.json(file);
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.delete("/api/memory/file", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "缺少 path" }, 400);
    try {
      workspace.memory.deleteFile(path);
      workspace.audit({ actor: "user", type: "memory.delete", summary: `删除 ${path}`, refs: [path] });
      return c.json({ ok: true });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.post("/api/memory/mkdir", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string };
    if (!body.path) return c.json({ error: "缺少 path" }, 400);
    try {
      workspace.memory.mkdir(body.path);
      return c.json({ ok: true });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.post("/api/memory/rename", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { from?: string; to?: string };
    if (!body.from || !body.to) return c.json({ error: "缺少 from/to" }, 400);
    try {
      workspace.memory.rename(body.from, body.to);
      return c.json({ ok: true });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.post("/api/memory/pin", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { path?: string; pinned?: boolean };
    if (!body.path) return c.json({ error: "缺少 path" }, 400);
    try {
      return c.json(workspace.memory.pin(body.path, body.pinned !== false));
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.get("/api/memory/activities", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const cursor = c.req.query("cursor") ?? undefined;
    return c.json(workspace.memory.listActivities(Number.isFinite(limit) ? limit : 50, cursor));
  });

  app.get("/api/memory/search", (c) => {
    const q = c.req.query("q") ?? "";
    return c.json({ hits: workspace.memory.search(q) });
  });

  // 笔记：全文检索、范围筛选、双链、保存、待办勾选。
  app.get("/api/notes", (c) => {
    const query = c.req.query("q") ?? "";
    const scope = (c.req.query("scope") ?? "all") as NoteScope;
    return c.json(notesPayload(workspace, query, scope));
  });

  app.get("/api/notes/file", (c) => {
    const path = c.req.query("path") ?? "";
    if (!path) return c.json({ error: "缺少文件路径" }, 400);
    try {
      return c.json(noteDetail(workspace, path));
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.put("/api/notes/file", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      path?: string;
      body?: string;
      expectedRevision?: string;
      title?: string;
    };
    if (!body.path) return c.json({ error: "缺少文件路径" }, 400);
    try {
      const saved = saveNote(workspace, {
        path: body.path,
        body: body.body ?? "",
        expectedRevision: body.expectedRevision ?? "",
        title: body.title,
      });
      return c.json(saved);
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.post("/api/notes", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; body?: string; date?: string };
    const title = body.title?.trim() || defaultNoteTitle(dateInZone(clock(), tz()));
    try {
      const created = createNote(workspace, { title, body: body.body ?? "", date: body.date });
      return c.json(created, 201);
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.post("/api/notes/todo", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      path?: string;
      index?: number;
      expectedRevision?: string;
    };
    if (!body.path || typeof body.index !== "number") return c.json({ error: "缺少参数" }, 400);
    try {
      const detail = noteDetail(workspace, body.path);
      const next = toggleTodoAt(detail.body, body.index);
      const saved = saveNote(workspace, { path: body.path, body: next, expectedRevision: detail.revision });
      return c.json({ ...saved, todos: extractTodos(saved.body) });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  // 会议一条龙：录音或粘贴的转录 → 纪要 → 写入 memory/meetings/ → 日记写回，待办进确认流。
  app.post("/api/meetings/summarize", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      transcript?: string;
      recordingId?: string;
      title?: string;
      date?: string;
      source?: "auto" | TranscriptSource;
      fileName?: string;
    };
    let transcript = (body.transcript ?? "").trim();
    let title = (body.title ?? "").trim();
    if (!transcript && body.recordingId) {
      try {
        const file = workspace.memory.readFile(`recordings/${body.recordingId}.md`);
        transcript = humanMemoryBody(file.content).trim();
        title = title || file.title;
      } catch {
        return c.json({ error: "找不到这段录音" }, 404);
      }
    }
    if (!transcript) return c.json({ error: "没有转录内容" }, 400);
    return c.json(
      await runMeetingFlow({
        transcript,
        title,
        date: body.date,
        source: body.source,
        fileName: body.fileName,
      }),
    );
  });

  // 腾讯会议 / 飞书妙记的转写导入：文本或文件内容都行，格式按仓库已有约定解析。
  app.post("/api/meetings/import", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string;
      transcript?: string;
      fileName?: string;
      title?: string;
      date?: string;
      source?: "auto" | TranscriptSource;
    };
    const transcript = (body.text ?? body.transcript ?? "").trim();
    if (!transcript) return c.json({ error: "没有转写内容" }, 400);
    return c.json(
      await runMeetingFlow({
        transcript,
        title: body.title,
        date: body.date,
        source: body.source,
        fileName: body.fileName,
      }),
    );
  });

  /** 转写 → 纪要 → 写进 memory/meetings/ → 待办进待确认队列（确认后才建任务）。 */
  async function runMeetingFlow(input: {
    transcript: string;
    title?: string;
    date?: string;
    source?: "auto" | TranscriptSource;
    fileName?: string;
  }) {
    const parsed = parseTranscript(input.transcript, {
      source: input.source ?? "auto",
      fileName: input.fileName,
    });
    const sourceLabel = TRANSCRIPT_SOURCE_LABELS[parsed.source];
    const title = (input.title ?? "").trim() || parsed.title || "";
    let provider: ModelProvider | null = null;
    let providerError = "";
    try {
      provider = workspace.resolveProvider();
    } catch (error) {
      providerError = error instanceof Error ? error.message : "模型不可用";
    }
    const summary = await summarizeMeeting({
      provider,
      providerError,
      transcript: parsed.text || input.transcript,
      title,
      source: sourceLabel,
      transcriptSource: parsed.source,
    });
    const capturedAt = formatIso(clock(), tz());
    const written = writeMeetingNote(workspace, {
      summary,
      title: summary.title,
      date: input.date ?? parsed.date ?? dateInZone(clock(), tz()),
      time: parsed.time ?? capturedAt.slice(11, 16),
      timezone: tz(),
      source: sourceLabel,
      capturedAt,
    });
    workspace.memory.appendDiary({
      fact: `开了一场会：${summary.title}。${summary.message}`,
      sourceLabel,
      sourceRef: `meeting:${written.path}`,
      actor: "agent",
    });
    const todos = attachTodoProvenance(summary.todos, {
      meetingTitle: summary.title,
      notePath: written.path,
      capturedAt,
      transcriptSource: parsed.source,
    });
    const confirmations = requestMeetingTodoConfirmations(workspace, {
      todos,
      meetingTitle: summary.title,
      notePath: written.path,
      capturedAt,
      transcriptSource: parsed.source,
      now: clock(),
      timezone: tz(),
    });
    return {
      ok: summary.modelUsed,
      message: summary.message,
      title: summary.title,
      body: written.body,
      todos,
      path: written.path,
      href: memoryHrefFor(written.path),
      confirmations,
      source: parsed.source,
      sourceLabel,
      format: parsed.format,
      transcript: summary.transcript,
      attempts: summary.attempts,
    };
  }

  app.get("/api/chats", (c) => c.json({ items: listChats(workspace.db) }));

  app.post("/api/chats", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    const chat = createChat(workspace.db, body.title ?? "新对话", tz());
    return c.json(chat, 201);
  });

  app.get("/api/chats/:id/messages", (c) => {
    const chat = getChat(workspace.db, c.req.param("id"));
    if (!chat) return c.json({ error: "找不到对话" }, 404);
    return c.json({ chat, items: listMessages(workspace.db, chat.id) });
  });

  app.post("/api/chats/:id/messages", async (c) => {
    const chat = getChat(workspace.db, c.req.param("id"));
    if (!chat) return c.json({ error: "找不到对话" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; role?: "user" | "system" };
    if (!body.content?.trim()) return c.json({ error: "缺少内容" }, 400);
    const message = addMessage(
      workspace.db,
      { chatId: chat.id, role: body.role ?? "user", content: body.content.trim() },
      tz(),
    );
    maybeTitle(chat.id, body.content);
    return c.json(message, 201);
  });

  app.post("/api/chats/:id/messages/stream", async (c) => {
    const chat = getChat(workspace.db, c.req.param("id"));
    if (!chat) return c.json({ error: "找不到对话" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    if (!body.content?.trim()) return c.json({ error: "缺少内容" }, 400);
    const settings = workspace.readSettings();
    addMessage(workspace.db, { chatId: chat.id, role: "user", content: body.content.trim() }, tz());
    maybeTitle(chat.id, body.content);
    const history = listMessages(workspace.db, chat.id);
    const messages = buildChatPrompt(workspace, history);
    const userText = body.content.trim();
    let provider;
    try {
      provider = workspace.resolveProvider();
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "模型不可用" }, 400);
    }

    return streamSSE(c, async (stream) => {
      let full = "";
      try {
        for await (const chunk of provider.stream(messages, { assistantName: settings.assistantName })) {
          if (chunk.text) {
            full += chunk.text;
            await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: chunk.text }) });
          }
        }
        let usageEventId: string | undefined;
        if (provider.type !== "mock") {
          const inputTokens = estimateTokens(messages.map((m) => m.content).join("\n"));
          const outputTokens = estimateTokens(full);
          const unit = unitCost(settings, provider.id);
          const usage = recordUsageEvent(
            workspace.db,
            {
              provider: provider.id,
              model: provider.modelId,
              purpose: "conversation",
              inputTokens,
              outputTokens,
              source: "byok",
              unitCostInUsd: unit,
              chatId: chat.id,
            },
            { timezone: tz() },
          );
          usageEventId = usage.id;
        }
        const assistant = addMessage(
          workspace.db,
          { chatId: chat.id, role: "assistant", content: full, usageEventId },
          tz(),
        );
        workspace.audit({
          actor: "agent",
          type: "model.call",
          summary: `对话 ${chat.id} 调用 ${provider.id}`,
          refs: usageEventId ? [chat.id, usageEventId] : [chat.id],
        });
        const memory = await runMemoryUpdate({
          chatId: chat.id,
          assistantMessageId: assistant.id,
          userText,
          assistantText: full,
          provider,
        });
        await stream.writeSSE({
          data: JSON.stringify({
            type: "done",
            messageId: assistant.id,
            usageEventId,
            text: full,
            memory: {
              diaryAppended: memory.diaryAppended,
              ...(memory.diaryPath ? { diaryPath: memory.diaryPath } : {}),
              ...(memory.note ? { note: memory.note } : {}),
              ...(memory.error ? { error: memory.error } : {}),
              confirmations: memory.confirmations,
            },
          }),
        });
      } catch (error) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: "error",
            error: modelErrorMessage(error),
          }),
        });
      }
    });
  });

  app.get("/api/tasks", (c) => {
    reapStaleRunningTasks(workspace.db, tz());
    return c.json({ items: listTasks(workspace.db) });
  });

  app.post("/api/tasks", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      instruction?: string;
      kind?: "on_demand" | "scheduled";
      schedule?: TaskScheduleBody;
    };
    if (!body.title?.trim()) return c.json({ error: "缺少标题" }, 400);
    let schedule = body.schedule;
    if (body.kind === "scheduled") {
      try {
        schedule = normalizeSchedule(body.schedule, { now: clock(), timezone: body.schedule?.timezone || tz() });
      } catch (error) {
        const message = error instanceof ScheduleError || error instanceof Error ? error.message : "无法保存定时";
        return c.json({ error: message }, 400);
      }
    }
    const task = createTask(
      workspace.db,
      { title: body.title, instruction: body.instruction, kind: body.kind, schedule },
      tz(),
    );
    return c.json(task, 201);
  });

  app.get("/api/tasks/:id", (c) => {
    reapStaleRunningTasks(workspace.db, tz());
    const task = getTask(workspace.db, c.req.param("id"));
    if (!task) return c.json({ error: "找不到任务" }, 404);
    return c.json({ task, events: listRunEvents(workspace.db, task.id) });
  });

  app.post("/api/tasks/:id/run", async (c) => {
    try {
      const result = await executeTaskRun({
        workspace,
        taskId: c.req.param("id"),
        timezone: tz(),
        trigger: "manual",
        now: clock(),
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof TaskRunError) return c.json({ error: error.message }, error.status);
      return c.json({ error: error instanceof Error ? error.message : "运行失败" }, 500);
    }
  });

  app.post("/api/tasks/:id/cancel", (c) => {
    const task = getTask(workspace.db, c.req.param("id"));
    if (!task) return c.json({ error: "找不到任务" }, 404);
    const cancelled = {
      ...task,
      status: "cancelled" as const,
      finishedAt: nowIso(tz()),
      updatedAt: nowIso(tz()),
    };
    saveTask(workspace.db, cancelled);
    addRunEvent(workspace.db, { taskId: task.id, type: "status", message: "已取消" }, tz());
    return c.json({ task: cancelled });
  });

  app.get("/api/confirmations", (c) => c.json({ items: workspace.confirmations.list() }));

  app.post("/api/confirmations/:id/approve", async (c) => {
    try {
      const item = workspace.confirmations.approve(c.req.param("id"));
      const executed = await safeExecute(item.id);
      workspace.audit({
        actor: "user",
        type: "confirmation.approved",
        summary: `批准 ${item.summary}`,
        refs: [item.id],
      });
      return c.json({ item, executed });
    } catch (error) {
      return confirmationError(c, error);
    }
  });

  app.post("/api/confirmations/:id/reject", (c) => {
    try {
      const item = workspace.confirmations.reject(c.req.param("id"));
      workspace.audit({
        actor: "user",
        type: "confirmation.rejected",
        summary: `拒绝 ${item.summary}`,
        refs: [item.id],
      });
      return c.json({ item });
    } catch (error) {
      return confirmationError(c, error);
    }
  });

  app.post("/api/confirmations/:id/edit-and-approve", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { preview?: string };
    if (typeof body.preview !== "string") return c.json({ error: "缺少 preview" }, 400);
    try {
      const item = workspace.confirmations.editAndApprove(c.req.param("id"), body.preview);
      const executed = await safeExecute(item.id);
      workspace.audit({
        actor: "user",
        type: "confirmation.edited_approved",
        summary: `编辑并批准 ${item.summary}`,
        refs: [item.id],
      });
      return c.json({ item, executed });
    } catch (error) {
      return confirmationError(c, error);
    }
  });

  /* ------------------------------- 主动消息 ------------------------------- */

  app.get("/api/proactive/state", (c) => c.json(proactiveStateView(workspace)));

  app.post("/api/proactive/read", (c) => {
    markProactiveRead(workspace, clock());
    return c.json({ ok: true, state: proactiveStateView(workspace) });
  });

  app.post("/api/proactive/resume", (c) => {
    resumeProactive(workspace, clock());
    return c.json({ ok: true, state: proactiveStateView(workspace) });
  });

  app.get("/api/proactive/notifications", (c) => c.json({ items: pendingNotifications(workspace) }));

  app.post("/api/proactive/notifications/ack", (c) => {
    acknowledgeNotifications(workspace);
    return c.json({ ok: true });
  });

  app.get("/api/usage/summary", (c) => c.json(summarizeUsage(workspace.db, tz())));
  app.get("/api/usage/events", (c) => c.json({ items: listUsageEvents(workspace.db, 200) }));
  app.get("/api/audit", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const cursor = c.req.query("cursor") ?? undefined;
    return c.json(listAudit(workspace.db, Number.isFinite(limit) ? limit : 50, cursor));
  });

  app.get("/api/export/memory.zip", async (c) => {
    const buf = await zipMemoryTree(workspace.memory.memoryRoot);
    workspace.audit({ actor: "user", type: "export.memory", summary: "导出记忆树 zip" });
    return c.body(Uint8Array.from(buf), 200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="huoye-memory.zip"',
    });
  });


  app.get("/api/health-notes", (c) => c.json(healthNotesPayload(workspace, clock())));

  app.post("/api/health-notes", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      sleep?: string;
      movement?: string;
      mood?: string;
      note?: string;
      date?: string;
    };
    try {
      const file = workspace.memory.appendHealthNote({
        date: typeof body.date === "string" && body.date.trim() ? body.date.trim() : undefined,
        sleep: typeof body.sleep === "string" ? body.sleep : "",
        movement: typeof body.movement === "string" ? body.movement : "",
        mood: typeof body.mood === "string" ? body.mood : "",
        note: typeof body.note === "string" ? body.note : "",
        sourceRef: "health:hand",
        actor: "owner",
      });
      workspace.audit({
        actor: "user",
        type: "health.append",
        summary: `记下健康记录 ${file.relativePath}`,
        refs: [file.relativePath],
      });
      return c.json({ file, ...healthNotesPayload(workspace, clock()) }, 201);
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.get("/api/today/cards", (c) => c.json(todayCardsPayload(workspace, clock())));

  app.get("/api/recordings", (c) => c.json(recordingsPayload(workspace)));

  app.post("/api/recordings", async (c) => {
    const form = await c.req.parseBody();
    const uploaded = form.file;
    if (!uploaded || typeof uploaded === "string") {
      return c.json({ error: "请先选择一个音频文件。" }, 400);
    }
    const source = form.source === "browser" ? "browser" : "upload";
    const bytes = Buffer.from(await uploaded.arrayBuffer());
    try {
      const saved = await saveUploadedRecording({
        workspace,
        bytes,
        originalName: uploaded.name || "audio",
        mimeType: uploaded.type,
        source,
        fetchImpl: options.fetchImpl,
      });
      return c.json(saved, 201);
    } catch (error) {
      if (error instanceof RecordingError) {
        return c.json({ error: error.message }, error.status);
      }
      return memoryError(c, error);
    }
  });

  app.get("/api/recordings/:id", (c) => {
    const file = workspace.memory.readRecordingNote(c.req.param("id"));
    if (!file) return c.json({ error: "找不到这段录音。" }, 404);
    const catalog = recordingsPayload(workspace);
    return c.json({
      item: toRecordingItem(file, workspace),
      transcribeConfigured: catalog.transcribeConfigured,
      meetings: catalog.meetings,
    });
  });

  app.put("/api/recordings/:id/note", async (c) => {
    const id = c.req.param("id");
    const existing = workspace.memory.readRecordingNote(id);
    if (!existing) return c.json({ error: "找不到这段录音。" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string; expectedRevision?: string };
    if (typeof body.content !== "string") return c.json({ error: "缺少纪要内容。" }, 400);
    try {
      const saved = workspace.memory.writeFile(
        existing.relativePath,
        bodyWithProvenance(body.content, existing.content),
        typeof body.expectedRevision === "string" ? body.expectedRevision : existing.revision,
        "owner",
      );
      return c.json({ item: toRecordingItem(saved, workspace) });
    } catch (error) {
      return memoryError(c, error);
    }
  });

  app.get("/api/recordings/:id/audio", (c) => {
    const audio = readRecordingAudio(workspace, c.req.param("id"));
    if (!audio) return c.json({ error: "找不到这段音频。" }, 404);
    const name = audio.fileName.replace(/[\r\n"]/g, "");
    const bytes = Uint8Array.from(audio.bytes);
    return c.body(bytes, 200, {
      "content-type": audio.mimeType || "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "accept-ranges": "bytes",
      "content-disposition": `inline; filename="${name}"`,
    });
  });

  app.post("/api/today/brief", async (c) => {
    try {
      const result = await generateAndSaveBrief({ workspace, now: clock(), timeZone: tz() });
      return c.json(result);
    } catch (error) {
      console.error("generate brief failed", error);
      return c.json({ error: "简报没有整理成功，请稍后再试。" }, 500);
    }
  });

  app.get("/api/today/brief", (c) => {
    return c.json(latestBriefPayload(workspace, clock()));
  });

  app.post("/api/confirmations", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.action !== "string" || !body.action.trim()) {
      return c.json({ error: "缺少 action" }, 400);
    }
    try {
      const item = workspace.confirmations.requestExternalWrite({
        action: body.action.trim(),
        target: typeof body.target === "string" ? body.target : "",
        summary: typeof body.summary === "string" ? body.summary : "待确认的动作",
        preview: typeof body.preview === "string" ? body.preview : "",
        risk: "medium",
        editable: body.editable !== false,
        toolPayload:
          body.toolPayload && typeof body.toolPayload === "object"
            ? (body.toolPayload as Record<string, unknown>)
            : { preview: body.preview },
        chatId: typeof body.chatId === "string" ? body.chatId : undefined,
        taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      });
      // 没有归属对话的确认，留在主对话里提醒一句；还是要用户点头才执行。
      if (!item.chatId) {
        try {
          notifyPendingConfirmation(
            workspace,
            { id: item.id, summary: item.summary, action: item.action },
            clock(),
            tz(),
          );
        } catch {
          // 提醒写不进去也不影响确认本身。
        }
      }
      return c.json(item, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "无法创建确认" }, 400);
    }
  });

  function tz(): string {
    return workspace.readSettings().timezone || "Asia/Shanghai";
  }

  /** 飞书 / Lark 事件回调：支持官方 URL 验证、加密事件与明文事件。 */
  async function handleLarkStyleEvent(c: Context, id: "feishu" | "lark") {
    const values = workspace.channels.values(id);
    const token = values.verificationToken ?? "";
    if (!token) return c.json(unauthorized(), 401);

    const raw = Buffer.from(await c.req.arrayBuffer());
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return c.json(unauthorized(), 401);
    }

    const encryptKey = values.encryptKey ?? "";
    if (encryptKey) {
      const timestamp = c.req.header("x-lark-request-timestamp") ?? "";
      const nonce = c.req.header("x-lark-request-nonce") ?? "";
      const signature = c.req.header("x-lark-signature") ?? "";
      if (!timestamp || !nonce || !signature) return c.json(unauthorized(), 401);
      const valid = verifyFeishuEventSignature({ timestamp, nonce, encryptKey, body: raw, signature });
      if (!valid) return c.json(unauthorized(), 401);
    }

    let body = payload;
    const encryptValue = typeof payload.encrypt === "string" ? payload.encrypt : "";
    if (encryptValue) {
      if (!encryptKey) return c.json(unauthorized(), 401);
      try {
        body = JSON.parse(decryptFeishuEncrypt(encryptValue, encryptKey)) as Record<string, unknown>;
      } catch {
        return c.json(unauthorized(), 401);
      }
    }

    if (body.type === "url_verification") {
      const bodyToken = typeof body.token === "string" ? body.token : "";
      if (!timingSafeEquals(bodyToken, token)) return c.json(unauthorized(), 401);
      const challenge = typeof body.challenge === "string" ? body.challenge : "";
      return c.json({ challenge });
    }

    if (!encryptKey) {
      const header = (body.header ?? {}) as Record<string, unknown>;
      const bodyToken =
        typeof body.token === "string" ? body.token : typeof header.token === "string" ? header.token : "";
      if (!timingSafeEquals(bodyToken, token)) return c.json(unauthorized(), 401);
    }

    await landInbound(id, parseFeishuEvent(body, id));
    return c.json({ ok: true }, 201);
  }

  /** 钉钉：机器人 HTTP 模式（请求头签名）与事件订阅推送（query 签名 + 加密体）。 */
  async function handleDingtalkEvent(c: Context) {
    const values = workspace.channels.values("dingtalk");
    const raw = Buffer.from(await c.req.arrayBuffer());
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      payload = {};
    }

    const querySignature = c.req.query("msg_signature") ?? c.req.query("signature") ?? "";
    const queryTimestamp = c.req.query("timestamp") ?? "";
    const queryNonce = c.req.query("nonce") ?? "";
    const encryptValue = typeof payload.encrypt === "string" ? payload.encrypt : "";

    if (querySignature || encryptValue) {
      const callbackToken = values.callbackToken ?? "";
      const aesKey = values.encodingAesKey ?? "";
      if (!callbackToken || !aesKey || !querySignature || !queryTimestamp || !queryNonce) {
        return c.json(unauthorized(), 401);
      }
      const expected = signDingtalkEvent({
        token: callbackToken,
        timestamp: queryTimestamp,
        nonce: queryNonce,
        encrypt: encryptValue,
      });
      if (!timingSafeEquals(expected, querySignature)) return c.json(unauthorized(), 401);
      const ownerKey = (values.appKey || values.corpId || "").trim();
      let decrypted: Record<string, unknown>;
      try {
        decrypted = JSON.parse(decryptDingtalkEvent(encryptValue, aesKey, ownerKey || undefined)) as Record<string, unknown>;
      } catch {
        return c.json(unauthorized(), 401);
      }
      const eventType = typeof decrypted.EventType === "string" ? decrypted.EventType : "";
      // check_url 只用于开放平台校验回调地址，不要写成聊天或日记。
      if (eventType !== "check_url") {
        await landInbound("dingtalk", parseDingtalkEventPayload(decrypted));
      }
      return c.json(
        dingtalkCallbackReply({
          plaintext: "success",
          token: callbackToken,
          encodingAesKey: aesKey,
          ownerKey,
          nonce: queryNonce,
          timestamp: queryTimestamp,
        }),
      );
    }

    const timestamp = c.req.header("timestamp") ?? "";
    const sign = c.req.header("sign") ?? "";
    const appSecret = values.appSecret ?? "";
    if (!timestamp || !sign || !appSecret) return c.json(unauthorized(), 401);
    const valid = verifyDingtalkRobotSignature({ timestamp, sign, appSecret, now: clock().getTime() });
    if (!valid) return c.json(unauthorized(), 401);
    await landInbound("dingtalk", parseDingtalkRobotBody(payload));
    return c.json({ ok: true }, 201);
  }

  /** 公众号 / 服务号的 URL 验证：校验签名后原样返回 echostr。 */
  async function handleWechatVerification(c: Context) {
    const values = workspace.channels.values("weixin");
    const token = values.token ?? "";
    const signature = c.req.query("signature") ?? "";
    const timestamp = c.req.query("timestamp") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    if (!token || !signature || !timestamp || !nonce) return c.json(unauthorized(), 401);
    const expected = signWechatCallback({ token, timestamp, nonce });
    if (!timingSafeEquals(expected, signature)) return c.json(unauthorized(), 401);
    return c.text(c.req.query("echostr") ?? "");
  }

  async function handleWechatMessage(c: Context) {
    const values = workspace.channels.values("weixin");
    const token = values.token ?? "";
    const signature = c.req.query("signature") ?? "";
    const timestamp = c.req.query("timestamp") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    if (!token || !signature || !timestamp || !nonce) return c.json(unauthorized(), 401);
    const expected = signWechatCallback({ token, timestamp, nonce });
    if (!timingSafeEquals(expected, signature)) return c.json(unauthorized(), 401);
    const xml = await c.req.text();
    await landInbound("weixin", parseWechatXml(xml));
    return c.text("success");
  }

  /** 入站落地：写一条 user 消息、写日记、记住最近会话对象。不自动向外回复。 */
  async function landInbound(id: ChannelId, event: InboundEvent, opts: { simulator?: boolean } = {}) {
    const def = channelDefById(id);
    if (!def) return undefined;
    const chat = findChannelChat(def.name);
    addMessage(workspace.db, { chatId: chat.id, role: "user", content: event.text }, tz());
    workspace.memory.appendDiary({
      fact: event.text,
      sourceLabel: `来自${def.name}${opts.simulator ? "（模拟器）" : ""}`,
      sourceRef: event.sourceRef,
      actor: "agent",
    });
    if (event.replyTo) {
      workspace.channelState.remember(id, {
        replyTo: event.replyTo,
        senderLabel: event.senderLabel,
        updatedAt: nowIso(tz()),
      });
    }
    workspace.audit({
      actor: "agent",
      type: "connector.channel.inbound",
      summary: `收到${def.name}消息`,
      refs: [id],
    });
    return chat;
  }

  function findChannelChat(title: string) {
    const existing = listChats(workspace.db).find((chat) => chat.title.trim() === title);
    return existing ?? createChat(workspace.db, title, tz());
  }

  function maybeTitle(chatId: string, content: string): void {
    const chat = getChat(workspace.db, chatId);
    if (chat && (chat.title === "新对话" || !chat.title)) {
      touchChat(workspace.db, chatId, tz(), content.trim().slice(0, 24));
    } else {
      touchChat(workspace.db, chatId, tz());
    }
  }

  async function safeExecute(id: string): Promise<{ ok: boolean; message: string }> {
    try {
      return await workspace.confirmations.execute(id, async (request) => {
        if (request.action === "memory.about_you.patch") {
          return applyMemoryPatch(request);
        }
        if (request.action === "task.create") {
          return applyTaskCreate(request);
        }
        if (request.action === "channel.message.send") {
          return executeChannelSend(request);
        }
        if (request.action.startsWith("demo.")) {
          return { ok: true, message: "演示动作已标记完成，没有真正发到外部。" };
        }
        return { ok: true, message: "已记下，这条消息没有发出去。" };
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "无法执行" };
    }
  }

  /**
   * 通道出站：只有通道已连接、而且真的有可投递的目的地时才会调用官方接口。
   * 没连接就说没连接，不假装已经发出。
   */
  async function executeChannelSend(request: ConfirmationRequest): Promise<{ ok: boolean; message: string }> {
    const payload = request.toolPayload as { channelId?: string; text?: string };
    const id = normalizeChannelId(request.connectorId ?? payload.channelId ?? "");
    if (!id) {
      return { ok: false, message: "这条确认没有指明通道，没有发出去。" };
    }
    const def = channelDefById(id);
    if (!def) return { ok: false, message: "这条确认没有指明通道，没有发出去。" };

    const values = workspace.channels.values(id);
    if (workspace.channels.status(id) !== "connected") {
      return { ok: true, message: "已记下，没有发出去（通道未连接）" };
    }

    const text = (payload.text ?? request.preview ?? "").trim();
    if (!text) {
      return { ok: true, message: "已记下，没有发出去（没有要发的内容）" };
    }

    const destination = workspace.channelState.last(id)?.replyTo;
    const result = await sendChannelMessage({
      channelId: id,
      def,
      values,
      text,
      destination,
      fetchImpl: options.fetchImpl,
      now: () => clock().getTime(),
    });
    return { ok: result.ok, message: result.message };
  }

  function applyMemoryPatch(request: ConfirmationRequest): { ok: boolean; message: string } {
    const payload = request.toolPayload as {
      targetPath?: string;
      replacements?: FieldReplacement[];
      preview?: string;
    };
    const targetPath = typeof payload.targetPath === "string" ? payload.targetPath : "";
    if (!targetPath.startsWith("about-you/")) {
      return { ok: false, message: "补丁的目标文件不合法。" };
    }
    const edited = parsePreviewReplacements(typeof payload.preview === "string" ? payload.preview : "");
    const replacements = edited.length
      ? edited
      : Array.isArray(payload.replacements)
        ? payload.replacements
        : [];
    if (!replacements.length) return { ok: false, message: "补丁里没有要写入的内容。" };
    try {
      const current = workspace.memory.readFile(targetPath);
      const next = applyFieldReplacements(current.content, replacements);
      workspace.memory.writeFile(targetPath, next, current.revision, "agent");
      return { ok: true, message: "已写入基本档案。" };
    } catch (error) {
      if (error instanceof MemoryConflictError) {
        return { ok: false, message: "这个文件在你确认之前被改过，请重新生成一次补丁。" };
      }
      return { ok: false, message: error instanceof Error ? error.message : "无法写入档案。" };
    }
  }

  /** 会议待办建任务：只有用户确认了才会真的建，出处也一起带进任务。 */
  function applyTaskCreate(request: ConfirmationRequest): { ok: boolean; message: string } {
    const payload = request.toolPayload as {
      title?: string;
      instruction?: string;
      text?: string;
      source?: string;
      provenance?: { meetingTitle?: string; notePath?: string; capturedAt?: string; source?: string };
    };
    const edited = typeof payload.text === "string" ? (payload.text.trim().split("\n")[0] ?? "").trim() : "";
    const title = (edited || (payload.title ?? "")).trim();
    if (!title) return { ok: false, message: "这条待办没有标题，没有建任务。" };
    const provenance = payload.provenance;
    const from = [
      provenance?.meetingTitle ?? "",
      provenance?.notePath ?? "",
      provenance?.capturedAt ?? "",
    ]
      .filter(Boolean)
      .join(" · ");
    const instruction = provenance
      ? [
          title,
          "",
          `出处：${provenance.source ?? payload.source ?? "转写里没写出处"}`,
          from ? `来自：${from}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : (payload.instruction ?? title);
    const task = createTask(workspace.db, { title, instruction, kind: "on_demand" }, tz());
    saveTask(workspace.db, { ...task, confirmationIds: [request.id] });
    return { ok: true, message: `已建任务：${task.title}` };
  }

  /**
   * 一轮对话之后写回记忆：日记事实、核心档案补丁、出站草稿、用户明确要的笔记。
   * 失败只记录，不影响已经完成的对话。
   */
  async function runMemoryUpdate(input: {
      chatId: string;
      assistantMessageId: string;
      userText: string;
      assistantText: string;
      provider: ModelProvider;
    },
  ): Promise<{
    diaryAppended: boolean;
    diaryPath?: string;
    error?: string;
    confirmations: ConfirmationRequest[];
    note?: { title: string; path: string; href: string };
  }> {
    const confirmations: ConfirmationRequest[] = [];
    let note: { title: string; path: string; href: string } | undefined;
    try {
      const settings = workspace.readSettings();
      const result = await extractMemoryUpdate({
        userText: input.userText,
        assistantText: input.assistantText,
        aboutYou: readAboutYouFiles(workspace),
        provider: input.provider,
      });
      let diaryPath: string | undefined;
      for (const item of result.diaryFacts) {
        const fact = item.fact.trim();
        if (!fact) continue;
        const file = workspace.memory.appendDiary({
          fact,
          sourceLabel: item.sourceLabel ?? "来自聊天",
          sourceRef: `chat:${input.chatId}/turn:${input.assistantMessageId}`,
          actor: "agent",
        });
        diaryPath = file.relativePath;
      }
      for (const patch of result.patches) {
        let baseRevision: string | undefined;
        try {
          baseRevision = workspace.memory.readFile(patch.targetPath).revision;
        } catch {
          baseRevision = undefined;
        }
        const item = workspace.confirmations.requestExternalWrite({
          action: "memory.about_you.patch",
          target: patch.targetPath,
          summary: patch.summary,
          preview: patch.preview,
          risk: "medium",
          editable: true,
          chatId: input.chatId,
          toolPayload: {
            targetPath: patch.targetPath,
            replacements: patch.replacements,
            baseRevision,
            summary: patch.summary,
            preview: patch.preview,
          },
        });
        confirmations.push(item);
      }
      if (result.outboundDraft) {
        const draft = result.outboundDraft;
        const item = workspace.confirmations.requestExternalWrite({
          action: draft.action,
          target: draft.target,
          summary: draft.summary,
          preview: draft.preview,
          risk: "medium",
          editable: true,
          chatId: input.chatId,
          connectorId: draft.connectorId ?? draft.channelId,
          toolPayload: { ...draft },
        });
        confirmations.push(item);
      }
      if (result.note) {
        // 用户明确说「写一页笔记」时，落地成一篇日常笔记，并给出可打开的链接。
        const created = createNoteFromChat(workspace, {
          title: result.note.title,
          body: result.note.body,
          date: dateInZone(clock(), tz()),
        });
        note = { title: created.title, path: created.path, href: created.href };
      }
      if (result.usedModel && input.provider) {
        recordUsageEvent(
          workspace.db,
          {
            provider: input.provider.id,
            model: input.provider.modelId,
            purpose: "memory_update",
            inputTokens: result.inputTokens ?? 0,
            outputTokens: result.outputTokens ?? 0,
            source: "byok",
            unitCostInUsd: unitCost(settings, input.provider.id),
            chatId: input.chatId,
          },
          { timezone: workspace.readSettings().timezone || "Asia/Shanghai" },
        );
      }
      return { diaryAppended: Boolean(diaryPath), diaryPath, confirmations, note };
    } catch (error) {
      return {
        diaryAppended: false,
        error: error instanceof Error ? error.message : "记忆更新失败",
        confirmations,
      };
    }
  }

  async function tickDueTasks(now?: Date) {
    return tickDueWork({ workspace, now: clock, timezone: tz }, now ?? clock());
  }

  function startAppScheduler(intervalMs?: number) {
    return startScheduler({ workspace, now: clock, timezone: tz }, { intervalMs });
  }

  return { app, workspace, tickDueTasks, startScheduler: startAppScheduler };
}


function unauthorized() {
  return { error: "签名无效或通道未配置" };
}

type TaskScheduleBody = {
  kind: "once" | "cron";
  runAt?: string;
  cron?: string;
  timezone: string;
  enabled: boolean;
};

function memoryError(c: { json: (data: unknown, status?: number) => Response }, error: unknown) {
  if (error instanceof MemoryConflictError) {
    return c.json(
      {
        error: "conflict",
        message: error.message,
        current: { revision: error.current.revision, snippet: error.current.snippet, content: error.current.content },
        incoming: {
          expectedRevision: error.incoming.expectedRevision,
          snippet: error.incoming.snippet,
          content: error.incoming.content,
        },
      },
      409,
    );
  }
  if (error instanceof MemoryPathError) return c.json({ error: error.message }, 400);
  if (error instanceof MemoryPermissionError) return c.json({ error: error.message }, 403);
  if (error instanceof MemoryNotFoundError) return c.json({ error: error.message }, 404);
  return c.json({ error: error instanceof Error ? error.message : "记忆操作失败" }, 500);
}

function confirmationError(c: { json: (data: unknown, status?: number) => Response }, error: unknown) {
  if (error instanceof ConfirmationError) {
    const status = error.code === "NOT_FOUND" ? 404 : 409;
    return c.json({ error: error.message, code: error.code }, status);
  }
  return c.json({ error: error instanceof Error ? error.message : "确认操作失败" }, 400);
}

function parsePreviewReplacements(preview: string): FieldReplacement[] {
  const out: FieldReplacement[] = [];
  for (const line of preview.split("\n")) {
    const match = line.match(/^\s*[-*]\s+([^：:]+)[：:]\s*(.+)$/);
    if (!match) continue;
    const field = match[1].trim();
    const value = match[2].trim();
    if (!field || !value) continue;
    out.push({ field, value });
  }
  return out;
}

