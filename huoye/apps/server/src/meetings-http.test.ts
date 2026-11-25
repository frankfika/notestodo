import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { Workspace } from "./workspace";

/** 固定时间：纪要文件名、记录时间都可复现。 */
const now = () => new Date("2026-11-23T10:30:00+08:00");

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

/** 假模型的回复：纪要正文里带上原文，落盘的纪要里就能看到这段转写。 */
const TENCENT_REPLY = JSON.stringify({
  title: "产品周会",
  body: ["讨论了预算与排期。", "", TENCENT_TRANSCRIPT].join("\n"),
  todos: [
    { text: "下周一之前发出报价单", source: "李四" },
    { text: "准备发布公告", source: "赵六" },
  ],
});

const FEISHU_REPLY = JSON.stringify({
  title: "上线同步会",
  body: ["确定了上线时间。", "", FEISHU_TRANSCRIPT].join("\n"),
  todos: [{ text: "准备发布公告", source: "赵六" }],
});

/** 假的 OpenAI 兼容接口：只回答注入的 fetch，绝不打到公网。 */
function fakeModelFetch(reply: string, calls: string[]): typeof fetch {
  return async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function tempApp(fetchImpl?: typeof fetch) {
  const home = mkdtempSync(path.join(os.tmpdir(), "huoye-meeting-http-"));
  const created = createApp({ home, now, fetchImpl });
  return { app: created.app, workspace: created.workspace, home };
}

/** 装一个假的 OpenAI 兼容模型，并且把它设成默认供应商。 */
function useFakeModel(workspace: Workspace): void {
  const settings = workspace.readSettings();
  workspace.writeSettings({
    providers: [
      ...settings.providers,
      {
        id: "mmx",
        type: "openai_compatible",
        name: "测试模型",
        baseUrl: "https://example.invalid/v1",
        modelId: "test-model",
        hasApiKey: false,
      },
    ],
  });
  workspace.setProviderKey("mmx", "sk-test-not-real");
  workspace.writeSettings({ defaultProviderId: "mmx" });
}

interface MeetingPayload {
  ok: boolean;
  message: string;
  title: string;
  body: string;
  path: string;
  sourceLabel: string;
  source: string;
  todos: Array<{ text: string; source: string; provenance?: { notePath?: string } }>;
  confirmations: Array<{ id: string; status: string; action: string; summary: string; preview: string }>;
}

describe("会议纪要的 HTTP 全流程", () => {
  it("导入腾讯会议转写：写进 memory/meetings/，待办进待确认队列，确认前不建任务", async () => {
    const calls: string[] = [];
    const { app, workspace, home } = tempApp(fakeModelFetch(TENCENT_REPLY, calls));
    useFakeModel(workspace);

    const imported = await app.request("/api/meetings/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: TENCENT_TRANSCRIPT, fileName: "腾讯会议.txt" }),
    });
    expect(imported.status).toBe(200);
    const payload = (await imported.json()) as MeetingPayload;

    expect(payload.ok).toBe(true);
    expect(payload.path.startsWith("meetings/")).toBe(true);
    expect(payload.body.length).toBeGreaterThan(0);
    expect(payload.title).toBe("产品周会");
    expect(payload.sourceLabel).toBe("腾讯会议");
    expect(payload.source).toBe("tencent_meeting");
    expect(payload.todos).toHaveLength(2);
    expect(payload.todos[0].text).toBe("下周一之前发出报价单");
    expect(payload.todos[0].source).toBe("李四");
    expect(payload.todos[0].provenance?.notePath).toBe(payload.path);
    expect(Array.isArray(payload.confirmations)).toBe(true);
    expect(payload.confirmations).toHaveLength(2);
    expect(payload.confirmations.every((item) => item.status === "pending")).toBe(true);
    expect(payload.confirmations.every((item) => item.action === "task.create")).toBe(true);

    // 纪要真的写进了记忆目录，文件里有这段转写。
    const noteFile = path.join(home, "memory", payload.path);
    expect(existsSync(noteFile)).toBe(true);
    const raw = readFileSync(noteFile, "utf8");
    expect(raw).toContain(TENCENT_TRANSCRIPT);
    expect(raw).toContain("会议主题");
    expect(raw).toContain("产品周会");
    expect(raw).toContain("下周一之前发出报价单（出处：李四）");
    expect(raw).toContain("出处：");
    expect(raw).toContain("腾讯会议");

    // 待确认队列里有这两条待办，任务还没建。
    const listed = await app.request("/api/confirmations");
    const confirmations = (await listed.json()) as {
      items: Array<{ id: string; status: string; action: string; preview: string }>;
    };
    const pending = confirmations.items.filter(
      (item) => item.action === "task.create" && item.status === "pending",
    );
    expect(pending).toHaveLength(2);
    expect(pending.some((item) => item.preview.includes("下周一之前发出报价单"))).toBe(true);

    const tasksRes = await app.request("/api/tasks");
    const tasks = (await tasksRes.json()) as { items?: Array<{ title?: string }> };
    expect(tasks.items ?? []).toHaveLength(0);

    // 模型是假的：请求只打到了注入的假接口。
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].startsWith("https://example.invalid/v1/")).toBe(true);
  });

  it("导入之后批准一条待办，才真的建出任务；另一条还等着", async () => {
    const calls: string[] = [];
    const { app, workspace } = tempApp(fakeModelFetch(TENCENT_REPLY, calls));
    useFakeModel(workspace);

    const imported = await app.request("/api/meetings/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: TENCENT_TRANSCRIPT, fileName: "腾讯会议.txt" }),
    });
    expect(imported.status).toBe(200);
    const payload = (await imported.json()) as MeetingPayload;

    const before = await app.request("/api/tasks");
    const beforeJson = (await before.json()) as { items?: Array<{ title?: string }> };
    expect(beforeJson.items ?? []).toHaveLength(0);

    const target = payload.confirmations.find((item) => item.preview.includes("下周一之前发出报价单"));
    expect(target).toBeTruthy();

    const approved = await app.request(`/api/confirmations/${target!.id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    const approvedJson = (await approved.json()) as {
      item: { id: string; status: string };
      executed: { ok: boolean; message: string };
    };
    expect(approvedJson.item.id).toBe(target!.id);
    expect(approvedJson.item.status).toBe("approved");
    expect(approvedJson.executed.ok).toBe(true);

    const after = await app.request("/api/tasks");
    const afterJson = (await after.json()) as {
      items?: Array<{ title?: string; instruction?: string; confirmationIds?: string[] }>;
    };
    const titles = (afterJson.items ?? []).map((item) => item.title ?? "");
    expect(titles).toContain("下周一之前发出报价单");
    expect(titles).not.toContain("准备发布公告");
    expect(titles).toHaveLength(1);
    const created = (afterJson.items ?? [])[0];
    expect(created?.instruction).toContain("出处：李四");
    expect(created?.confirmationIds).toContain(target!.id);

    // 没批准的那条还留在待确认队列里。
    const listed = await app.request("/api/confirmations");
    const confirmations = (await listed.json()) as {
      items: Array<{ id: string; status: string }>;
    };
    const stillPending = confirmations.items.filter((item) => item.status === "pending");
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].id).not.toBe(target!.id);
  });

  it("POST /api/meetings/summarize 也能整理飞书妙记的转写", async () => {
    const calls: string[] = [];
    const { app, workspace, home } = tempApp(fakeModelFetch(FEISHU_REPLY, calls));
    useFakeModel(workspace);

    const summarized = await app.request("/api/meetings/summarize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: FEISHU_TRANSCRIPT, fileName: "飞书妙记.txt" }),
    });
    expect(summarized.status).toBe(200);
    const payload = (await summarized.json()) as MeetingPayload;

    expect(payload.ok).toBe(true);
    expect(payload.path.startsWith("meetings/")).toBe(true);
    expect(payload.title).toBe("上线同步会");
    expect(payload.sourceLabel).toBe("飞书妙记");
    expect(payload.todos).toHaveLength(1);
    expect(payload.todos[0].source).toBe("赵六");
    expect(payload.confirmations).toHaveLength(1);

    const noteFile = path.join(home, "memory", payload.path);
    expect(existsSync(noteFile)).toBe(true);
    expect(readFileSync(noteFile, "utf8")).toContain(FEISHU_TRANSCRIPT);

    const tasksRes = await app.request("/api/tasks");
    const tasks = (await tasksRes.json()) as { items?: Array<{ title?: string }> };
    expect(tasks.items ?? []).toHaveLength(0);
  });

  it("没有转写内容时导入接口直接拒绝，不写文件", async () => {
    const calls: string[] = [];
    const { app, workspace, home } = tempApp(fakeModelFetch(TENCENT_REPLY, calls));
    useFakeModel(workspace);

    const rejected = await app.request("/api/meetings/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(rejected.status).toBe(400);
    const error = (await rejected.json()) as { error?: string };
    expect(error.error).toBe("没有转写内容");
    expect(readdirSync(path.join(home, "memory", "meetings"))).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
