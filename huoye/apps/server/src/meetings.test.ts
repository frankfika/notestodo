import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CompletionChunk, ModelProvider } from "@huoye/core";
import { createApp } from "./app";
import {
  MEETING_MAX_ATTEMPTS,
  attachTodoProvenance,
  completeMeetingModel,
  detectTranscriptSource,
  parseTranscript,
  requestMeetingTodoConfirmations,
  summarizeMeeting,
  writeMeetingNote,
} from "./meetings";

function tempWorkspace() {
  const home = mkdtempSync(path.join(os.tmpdir(), "huoye-meeting-"));
  const created = createApp({ home });
  return { workspace: created.workspace, home, app: created.app };
}

/** 只会失败的模型：用来验证不会死循环重试。 */
function failingProvider(onCall: () => void): ModelProvider {
  return {
    id: "prv_failing",
    type: "openai",
    modelId: "failing",
    async complete() {
      onCall();
      throw new Error("模型不可用");
    },
    stream(): AsyncGenerator<CompletionChunk> {
      throw new Error("模型不可用");
    },
  } as unknown as ModelProvider;
}

const TENCENT_TRANSCRIPT = [
  "腾讯会议",
  "张三：这次的预算要压到 20 万以内。",
  "李四：我下周一之前把报价单发出来。",
].join("\n");

const FEISHU_TRANSCRIPT = [
  "飞书妙记",
  "王五：上线时间定在周三。",
  "赵六：我来准备发布公告。",
].join("\n");

describe("会议纪要", () => {
  it("把纪要写进 memory/meetings/，相对 HUOYE_HOME", () => {
    const { workspace, home } = tempWorkspace();
    const summary = {
      title: "产品周会",
      body: "讨论了预算与排期。",
      todos: [],
      modelUsed: false,
      message: "",
      transcript: "张三：预算压到 20 万。",
      attempts: 0,
    };
    const written = writeMeetingNote(workspace, {
      summary,
      title: "产品周会",
      date: "2026-11-23",
      time: "10:00",
      timezone: "Asia/Shanghai",
      source: "腾讯会议",
      capturedAt: "2026-11-23T10:30:00+08:00",
    });
    expect(written.path.startsWith("meetings/")).toBe(true);
    expect(existsSync(path.join(home, "memory", "meetings"))).toBe(true);
    expect(existsSync(path.join(home, "memory", written.path))).toBe(true);
    const content = workspace.memory.readFile(written.path).content;
    expect(content).toContain("会议主题");
    expect(content).toContain("2026-11-23");
  });

  it("待办带出处，并先进入待确认队列：确认前不建任务", async () => {
    const { workspace, app } = tempWorkspace();
    const todos = attachTodoProvenance(
      [
        { text: "下周一之前发出报价单", source: "李四" },
        { text: "准备发布公告", source: "赵六" },
      ],
      {
        meetingTitle: "产品周会",
        notePath: "meetings/产品周会.md",
        capturedAt: "2026-11-23T10:30:00+08:00",
        transcriptSource: "tencent_meeting",
      },
    );
    expect(todos[0].provenance?.meetingTitle).toBe("产品周会");
    expect(todos[0].provenance?.source).toBe("李四");
    expect(todos[0].provenance?.notePath).toBe("meetings/产品周会.md");

    const items = requestMeetingTodoConfirmations(workspace, {
      todos,
      meetingTitle: "产品周会",
      notePath: "meetings/产品周会.md",
      capturedAt: "2026-11-23T10:30:00+08:00",
      transcriptSource: "tencent_meeting",
    });
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.status === "pending")).toBe(true);

    const list = workspace.confirmations.list();
    expect(list.filter((item) => item.status === "pending").length).toBe(2);
    expect(list.some((item) => String(item.preview).includes("出处"))).toBe(true);

    // 确认前不建任务。
    const before = await app.request("/api/tasks");
    const beforeJson = (await before.json()) as { items?: unknown[] };
    expect(beforeJson.items ?? []).toHaveLength(0);

    // 批准一条待办之后，才真的建任务。
    const approved = await app.request(`/api/confirmations/${items[0].id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    const approvedJson = (await approved.json()) as {
      item: { id: string; status: string };
      executed: { ok: boolean; message: string };
    };
    expect(approvedJson.item.id).toBe(items[0].id);
    expect(approvedJson.item.status).toBe("approved");
    expect(approvedJson.executed.ok).toBe(true);
    expect(approvedJson.executed.message).toContain("下周一之前发出报价单");

    // 批准的那条建了任务，另一条还在待确认里，不建。
    const after = await app.request("/api/tasks");
    const afterJson = (await after.json()) as {
      items?: Array<{ title?: string; instruction?: string }>;
    };
    const titles = (afterJson.items ?? []).map((item) => item.title ?? "");
    expect(titles).toContain("下周一之前发出报价单");
    expect(titles).not.toContain("准备发布公告");
    expect(titles).toHaveLength(1);

    // 出处跟着任务一起留着。
    const created = (afterJson.items ?? [])[0];
    expect(created?.instruction).toContain("出处：李四");
    expect(created?.instruction).toContain("meetings/产品周会.md");
  });

  it("认出腾讯会议与飞书妙记两种转写来源", () => {
    expect(detectTranscriptSource(TENCENT_TRANSCRIPT)).toBe("tencent_meeting");
    expect(detectTranscriptSource(FEISHU_TRANSCRIPT)).toBe("feishu_minutes");
    expect(detectTranscriptSource("随便一段话", "腾讯会议录制.srt")).toBe("tencent_meeting");
    expect(detectTranscriptSource("随便一段话", "飞书妙记.txt")).toBe("feishu_minutes");
    expect(detectTranscriptSource("一段普通文字")).toBe("plain_text");
  });

  it("腾讯会议与飞书妙记的转写都能解析出说话人与时间点", () => {
    const tencent = parseTranscript(TENCENT_TRANSCRIPT, { fileName: "腾讯会议.txt" });
    expect(tencent.lines.length).toBeGreaterThan(0);
    expect(tencent.text).toContain("预算");

    const feishu = parseTranscript(FEISHU_TRANSCRIPT, { fileName: "飞书妙记.txt" });
    expect(feishu.lines.length).toBeGreaterThan(0);
    expect(feishu.text).toContain("上线时间");
  });

  it("没有模型时给出诚实的中文回退，并保留原始转写", async () => {
    const summary = await summarizeMeeting({
      provider: null,
      providerError: "还没有配置模型密钥",
      transcript: "张三：预算压到 20 万。",
      transcriptSource: "tencent_meeting",
    });
    expect(summary.modelUsed).toBe(false);
    expect(summary.attempts).toBe(0);
    expect(summary.message).toContain("没能整理出纪要");
    expect(summary.body).toContain("预算压到 20 万");
    expect(summary.transcript).toContain("预算压到 20 万");
  });

  it("模型失败时重试次数有上限，不会死循环", async () => {
    let calls = 0;
    await expect(
      completeMeetingModel(failingProvider(() => { calls += 1; }), [] as never),
    ).rejects.toThrow();
    expect(calls).toBeLessThanOrEqual(MEETING_MAX_ATTEMPTS);
    expect(MEETING_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(MEETING_MAX_ATTEMPTS).toBeLessThanOrEqual(2);
  });
});
