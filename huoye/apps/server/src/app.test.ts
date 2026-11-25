import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { nowIso } from "@huoye/schema";
import { createApp } from "./app";
import { addRunEvent, saveTask } from "./records";

function tempApp(options: { now?: () => Date; fetchImpl?: typeof fetch } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "huoye-server-"));
  const created = createApp({ home, now: options.now, fetchImpl: options.fetchImpl });
  return { app: created.app, workspace: created.workspace, home, tickDueTasks: created.tickDueTasks };
}

const ENV_KEY_NAMES = ["MINIMAX_API_KEY", "MINIMAX_PLATFORM_API_KEY", "OPENAI_API_KEY"] as const;

async function withFakeEnvKeys(run: () => Promise<void>): Promise<void> {
  const previous: Partial<Record<(typeof ENV_KEY_NAMES)[number], string | undefined>> = {};
  for (const name of ENV_KEY_NAMES) {
    previous[name] = process.env[name];
    process.env[name] = `env-${name}-must-not-be-used`;
  }
  try {
    await run();
  } finally {
    for (const name of ENV_KEY_NAMES) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("@huoye/server", () => {
  it("returns health", async () => {
    const { app } = tempApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "huoye" });
  });

  it("returns 409 when memory PUT expectedRevision does not match", async () => {
    const { app, workspace } = tempApp();
    const file = workspace.memory.readFile("about-you/profile.md");
    writeFileSync(path.join(workspace.paths.memory, "about-you/profile.md"), `${file.content}\n外部改动。\n`, "utf8");
    const res = await app.request(`/api/memory/file?path=${encodeURIComponent("about-you/profile.md")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `${file.content}\n我的草稿。\n`, expectedRevision: file.revision }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; current: { snippet: string }; incoming: { snippet: string } };
    expect(body.error).toBe("conflict");
    expect(body.current.snippet).toContain("外部改动");
    expect(body.incoming.snippet).toContain("我的草稿");
  });

  it("exports a zip that contains about-you/profile.md and is never paywalled", async () => {
    const { app } = tempApp();
    const res = await app.request("/api/export/memory.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/zip/);
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file("about-you/profile.md");
    expect(entry).toBeTruthy();
    const text = await entry!.async("string");
    expect(text).toContain("基本档案");
  });

  it("rejects path traversal on memory file reads", async () => {
    const { app } = tempApp();
    const res = await app.request("/api/memory/file?path=../config.json");
    expect(res.status).toBe(400);
  });

  it("does not start a new workspace with a phantom pending confirmation", async () => {
    const { app } = tempApp();
    const list = await app.request("/api/confirmations");
    expect(list.status).toBe(200);
    const data = (await list.json()) as { items: Array<{ status: string; action: string; summary: string }> };
    expect(data.items.filter((item) => item.status === "pending")).toEqual([]);
    expect(data.items.some((item) => item.action === "demo.message.send" || item.summary.includes("拟发送"))).toBe(false);
  });

  it("runs a mock task to a terminal completed state and keeps events", async () => {
    const { app } = tempApp();
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "整理桌面", instruction: "把桌面的草稿收一下" }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; status: string };
    expect(task.status).toBe("draft");

    const run = await app.request(`/api/tasks/${task.id}/run`, { method: "POST" });
    expect(run.status).toBe(200);
    const body = (await run.json()) as {
      task: { status: string; finishedAt?: string; startedAt?: string };
      events: Array<{ type: string; message: string }>;
    };
    expect(body.task.status).toBe("completed");
    expect(body.task.finishedAt).toBeTruthy();
    expect(body.task.startedAt).toBeTruthy();
    expect(body.events.some((e) => e.type === "status" && e.message.includes("已完成"))).toBe(true);
    expect(body.events.some((e) => e.type === "model")).toBe(true);

    const again = await app.request(`/api/tasks/${task.id}`);
    const latest = (await again.json()) as { task: { status: string } };
    expect(latest.task.status).toBe("completed");
  });

  it("cancels a running task after run events already exist", async () => {
    const { app, workspace } = tempApp();
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "需要取消的任务" }),
    });
    const task = (await created.json()) as { id: string; title: string; instruction: string; kind: string; status: string; confirmationIds: string[]; createdAt: string; updatedAt: string };
    const tz = workspace.settings.timezone;
    saveTask(workspace.db, {
      ...task,
      kind: "on_demand",
      status: "running",
      startedAt: nowIso(tz),
      updatedAt: nowIso(tz),
    });
    addRunEvent(workspace.db, { taskId: task.id, type: "status", message: "开始运行（mock）" }, tz);

    const cancel = await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as { task: { status: string; finishedAt?: string } };
    expect(body.task.status).toBe("cancelled");
    expect(body.task.finishedAt).toBeTruthy();

    const detail = await app.request(`/api/tasks/${task.id}`);
    const latest = (await detail.json()) as { task: { status: string }; events: Array<{ message: string }> };
    expect(latest.task.status).toBe("cancelled");
    expect(latest.events.length).toBeGreaterThan(0);
    expect(latest.events.some((e) => e.message.includes("已取消"))).toBe(true);
  });

  it("rejects creating a memory file with a bogus expectedRevision", async () => {
    const { app, workspace } = tempApp();
    const relative = "about-you/qa-create.md";
    const res = await app.request(`/api/memory/file?path=${encodeURIComponent(relative)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# 试验\n\n不应被创建。\n", expectedRevision: "deadbeef" }),
    });
    expect(res.status).toBe(409);
    expect(existsSync(path.join(workspace.paths.memory, relative))).toBe(false);

    const created = await app.request(`/api/memory/file?path=${encodeURIComponent(relative)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "---\ntitle: 试验\nkind: about_you\n---\n\n# 试验\n\n可以创建。\n", expectedRevision: "" }),
    });
    expect(created.status).toBe(200);
    const activities = await app.request("/api/memory/activities");
    const log = (await activities.json()) as { items: Array<{ path: string; op: string }> };
    expect(log.items.some((a) => a.path === relative && a.op === "create")).toBe(true);
  });

  it("writes onboarding display name into about-you/profile.md", async () => {
    const { app, workspace } = tempApp();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "方陈", assistantName: "叶", onboardingCompleted: true }),
    });
    expect(res.status).toBe(200);
    const profile = workspace.memory.readFile("about-you/profile.md");
    expect(profile.content).toMatch(/^- 称呼：方陈$/m);
  });

  it("does not let an empty-key provider steal the Mock default", async () => {
    const { app } = tempApp();
    const current = (await (await app.request("/api/settings")).json()) as {
      defaultProviderId?: string;
      providers: Array<{ id: string }>;
    };
    expect(current.defaultProviderId).toBe("mock");
    const id = "prv_empty_key";
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        defaultProviderId: id,
        providers: [
          ...current.providers,
          { id, type: "openai_compatible", name: "空密钥", baseUrl: "https://example.invalid/v1", modelId: "demo", hasApiKey: false },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const after = (await (await app.request("/api/settings")).json()) as {
      defaultProviderId?: string;
      providers: Array<{ id: string }>;
    };
    expect(after.defaultProviderId).toBe("mock");
    expect(after.providers.some((p) => p.id === id)).toBe(false);
  });

  it("allows deleting a non-default extra provider", async () => {
    const { app, workspace } = tempApp();
    const current = (await (await app.request("/api/settings")).json()) as {
      defaultProviderId?: string;
      providers: Array<{ id: string; type: string; name: string; modelId: string }>;
    };
    const id = "prv_to_delete";
    const add = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: [
          ...current.providers,
          { id, type: "openai_compatible", name: "备用", baseUrl: "https://example.invalid/v1", modelId: "demo", hasApiKey: false },
        ],
      }),
    });
    expect(add.status).toBe(200);
    workspace.setProviderKey(id, "sk-test-not-used");
    const blocked = await app.request("/api/settings/providers/mock", { method: "DELETE" });
    expect(blocked.status).toBe(400);
    const res = await app.request(`/api/settings/providers/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const after = (await res.json()) as { defaultProviderId?: string; providers: Array<{ id: string }> };
    expect(after.defaultProviderId).toBe("mock");
    expect(after.providers.some((p) => p.id === id)).toBe(false);
  });

  it("lists diaries and about-you folders over HTTP", async () => {
    const { app } = tempApp();
    const diaries = await app.request("/api/memory/folder?path=diaries");
    expect(diaries.status).toBe(200);
    const diariesBody = (await diaries.json()) as { type: string; name: string };
    expect(diariesBody).toMatchObject({ type: "dir", name: "diaries" });
    const about = await app.request("/api/memory/folder?path=about-you");
    expect(about.status).toBe(200);
    const aboutBody = (await about.json()) as { type: string; children: Array<{ name: string }> };
    expect(aboutBody.type).toBe("dir");
    expect(aboutBody.children.some((c) => c.name === "profile.md")).toBe(true);
  });
});

type TestApp = ReturnType<typeof createApp>["app"];

async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const raw = await res.text();
  const events: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    events.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return events;
}

async function newChat(app: TestApp): Promise<string> {
  const created = await app.request("/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "新对话" }),
  });
  const chat = (await created.json()) as { id: string };
  return chat.id;
}

async function say(app: TestApp, chatId: string, content: string): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/chats/${chatId}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const events = await readSse(res);
  const done = events.find((event) => event.type === "done");
  expect(done).toBeTruthy();
  return done!;
}

function todayStamp(timeZone = "Asia/Shanghai", date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

describe("@huoye/server memory loop", () => {
  it("writes chat facts into the diary and asks before touching the core profile", async () => {
    const { app, workspace } = tempApp();
    const chatId = await newChat(app);
    const done = await say(app, chatId, "我叫方陈，在上海做产品，晚上不喜欢被打断");

    const memory = done.memory as { diaryAppended: boolean; confirmations: Array<{ action: string; id: string; status: string }> };
    expect(memory.diaryAppended).toBe(true);

    const diary = workspace.memory.readFile(`diaries/${todayStamp()}.md`);
    expect(diary.content).toContain("方陈");
    expect(diary.content).toContain("出处：chat:");

    const pending = memory.confirmations.filter((item) => item.action === "memory.about_you.patch");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((item) => item.status === "pending")).toBe(true);

    const profileBefore = workspace.memory.readFile("about-you/profile.md").content;
    expect(profileBefore).not.toContain("- 称呼：方陈");

    for (const item of pending) {
      const approved = await app.request(`/api/confirmations/${item.id}/approve`, { method: "POST" });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as { executed: { ok: boolean; message: string } };
      expect(body.executed.ok).toBe(true);
    }

    expect(workspace.memory.readFile("about-you/profile.md").content).toMatch(/^- 称呼：方陈$/m);
    expect(workspace.memory.readFile("about-you/profile.md").content).toMatch(/^- 所在城市：上海$/m);
    expect(workspace.memory.readFile("about-you/work.md").content).toContain("产品");
    expect(workspace.memory.readFile("about-you/lifestyle.md").content).toContain("作息");

    const usage = (await (await app.request("/api/usage/events")).json()) as {
      items: Array<{ purpose: string }>;
    };
    expect(usage.items.some((item) => item.purpose === "memory_update")).toBe(false);
  });

  it("builds a real brief, saves it on disk and reads it back", async () => {
    const { app, workspace } = tempApp();
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "方陈", onboardingCompleted: true }),
    });

    const profile = workspace.memory.readFile("about-you/profile.md");
    await app.request(`/api/memory/file?path=${encodeURIComponent("about-you/profile.md")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: profile.content.replace("- 所在城市：", "- 所在城市：上海"),
        expectedRevision: profile.revision,
      }),
    });

    const res = await app.request("/api/today/brief", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      text: string;
      slot: string;
      source: string;
      path: string;
      nextAnchor: { label: string };
    };
    expect(body.text).toContain("方陈");
    expect(body.text).toContain("上海");
    expect(body.text).not.toContain("基本档案");
    expect(body.text).not.toContain("把你希望活页记住");
    expect(body.text.length).toBeLessThan(280);
    expect(body.source).toBe("local");
    expect(body.path).toMatch(/^briefs\/\d{4}-\d{2}-\d{2}-(morning|evening)\.md$/);
    expect(existsSync(path.join(workspace.paths.memory, body.path))).toBe(true);
    expect(body.nextAnchor.label.length).toBeGreaterThan(0);

    const latest = await app.request("/api/today/brief");
    expect(latest.status).toBe(200);
    const got = (await latest.json()) as { text: string; path: string };
    expect(got.text).toBe(body.text);
    expect(got.path).toBe(body.path);

    const usage = (await (await app.request("/api/usage/events")).json()) as {
      items: Array<{ purpose: string }>;
    };
    expect(usage.items.some((item) => item.purpose === "brief")).toBe(false);
  });

  it("turns a drafted message into a confirmation that never sends anything", async () => {
    const { app } = tempApp();
    const chatId = await newChat(app);
    const done = await say(app, chatId, "帮我拟一条发给同事的消息，先别发出去");

    const memory = done.memory as {
      confirmations: Array<{ id: string; action: string; status: string; summary: string; preview: string }>;
    };
    const draft = memory.confirmations.find((item) => item.action === "message.draft.send");
    expect(draft).toBeTruthy();
    expect(draft!.status).toBe("pending");
    expect(draft!.preview.length).toBeGreaterThan(0);

    const approved = await app.request(`/api/confirmations/${draft!.id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as {
      item: { status: string };
      executed: { ok: boolean; message: string };
    };
    expect(body.item.status).toBe("approved");
    expect(body.executed.ok).toBe(true);
    expect(body.executed.message).toMatch(/没有发出去|没有发到外部|尚未接到真实出站/);

    const list = (await (await app.request("/api/confirmations")).json()) as {
      items: Array<{ id: string; status: string }>;
    };
    expect(list.items.some((item) => item.id === draft!.id && item.status === "approved")).toBe(true);
  });

  it("runs a task with the profile in context and writes the result into the diary", async () => {
    const { app, workspace } = tempApp();
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "方陈", onboardingCompleted: true }),
    });
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "根据我的档案，列一下明天三件该先做的事",
        instruction: "根据我的档案，列一下明天三件该先做的事。",
      }),
    });
    const task = (await created.json()) as { id: string };

    const run = await app.request(`/api/tasks/${task.id}/run`, { method: "POST" });
    expect(run.status).toBe(200);
    const body = (await run.json()) as {
      task: { status: string; finishedAt?: string };
      events: Array<{ type: string; message: string }>;
    };
    expect(body.task.status).toBe("completed");
    expect(body.task.finishedAt).toBeTruthy();
    expect(body.events.some((event) => event.type === "model")).toBe(true);
    expect(body.events.some((event) => event.message.includes("已完成"))).toBe(true);

    const diary = workspace.memory.readFile(`diaries/${todayStamp()}.md`);
    expect(diary.content).toContain("出处：task:");
  });

  it("extracts a Hangzhou trip from the exact QA utterance and keeps it out of a restated lifestyle patch", async () => {
    const { app, workspace } = tempApp();
    const lifestyle = workspace.memory.readFile("about-you/lifestyle.md");
    await app.request(`/api/memory/file?path=${encodeURIComponent("about-you/lifestyle.md")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: lifestyle.content.replace("- 作息：", "- 作息：晚上不喜欢被打断"),
        expectedRevision: lifestyle.revision,
      }),
    });
    const chatId = await newChat(app);
    const utterance = "记一下：我下周要去杭州出差三天，晚上还是不喜欢被打断。";
    const done = await say(app, chatId, utterance);
    const memory = done.memory as {
      diaryAppended: boolean;
      confirmations: Array<{ action: string; preview: string; target: string }>;
    };
    expect(memory.diaryAppended).toBe(true);
    const diary = workspace.memory.readFile(`diaries/${todayStamp()}.md`);
    expect(diary.content).toMatch(/杭州出差/);
    expect(diary.content).toMatch(/三天/);
    const lifestylePatches = memory.confirmations.filter(
      (item) => item.action === "memory.about_you.patch" && item.target.includes("lifestyle"),
    );
    expect(lifestylePatches).toEqual([]);
    expect(JSON.stringify(memory.confirmations)).not.toContain("还是");

    const brief = (await (await app.request("/api/today/brief", { method: "POST" })).json()) as { text: string };
    expect(brief.text).toMatch(/杭州出差/);
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "numeric", hourCycle: "h23" }).format(
        new Date(),
      ),
    );
    if (hour >= 11 && hour < 18) {
      expect(brief.text).toContain("下午好");
      expect(brief.text).not.toContain("上午好");
    }

    const usage = (await (await app.request("/api/usage/events")).json()) as {
      items: Array<{ purpose: string }>;
    };
    expect(usage.items.some((item) => item.purpose === "conversation")).toBe(false);
    expect(usage.items.some((item) => item.purpose === "brief")).toBe(false);
    expect(usage.items.some((item) => item.purpose === "memory_update")).toBe(false);
  });

  it("drafts a late-arrival message, does not journal it as a fact, and does not send on approve", async () => {
    const { app, workspace } = tempApp();
    const chatId = await newChat(app);
    const utterance = "帮我拟一条发给同事的消息，先别发出去，就说明天上午我可能晚到。";
    const done = await say(app, chatId, utterance);
    const memory = done.memory as {
      diaryAppended: boolean;
      confirmations: Array<{ id: string; action: string; status: string; preview: string }>;
    };
    const draft = memory.confirmations.find((item) => item.action === "message.draft.send");
    expect(draft).toBeTruthy();
    expect(draft!.preview).toMatch(/明天上午.*晚到/);
    expect(memory.diaryAppended).toBe(false);
    const approved = await app.request(`/api/confirmations/${draft!.id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as { executed: { ok: boolean; message: string } };
    expect(body.executed.ok).toBe(true);
    expect(body.executed.message).toMatch(/没有发出去|没有发到外部|尚未接到真实出站/);
    const diaryPath = `diaries/${todayStamp()}.md`;
    try {
      const diary = workspace.memory.readFile(diaryPath);
      expect(diary.content).not.toContain("先别发出去");
      expect(diary.content).not.toContain("拟一条发给同事");
    } catch {
      // 没有日记文件也可以
    }
  });

  it("reaps a stale running task so it no longer occupies 今日任务", async () => {
    const { app, workspace } = tempApp();
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "整理桌面备忘", instruction: "把桌上的备忘收一下" }),
    });
    const task = (await created.json()) as {
      id: string;
      title: string;
      instruction: string;
      kind: string;
      status: string;
      confirmationIds: string[];
      createdAt: string;
      updatedAt: string;
    };
    saveTask(workspace.db, {
      ...task,
      kind: "on_demand",
      status: "running",
      startedAt: "2020-01-01T11:36:54+08:00",
      updatedAt: "2020-01-01T11:36:54+08:00",
    });

    const list = await app.request("/api/tasks");
    const body = (await list.json()) as { items: Array<{ id: string; status: string; errorMessage?: string }> };
    const found = body.items.find((item) => item.id === task.id);
    expect(found?.status).toBe("failed");
    expect(found?.errorMessage).toContain("运行中断");

    const cancel = await app.request(`/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    const cancelled = (await cancel.json()) as { task: { status: string } };
    expect(cancelled.task.status).toBe("cancelled");
  });

  it("fulfills a list-three-things task without saying 未对外写入 when a diary entry is written", async () => {
    const { app, workspace } = tempApp();
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "列出三件小事", instruction: "用一句话列出今天可以做的三件小事。" }),
    });
    const task = (await created.json()) as { id: string };
    const run = await app.request(`/api/tasks/${task.id}/run`, { method: "POST" });
    const body = (await run.json()) as {
      task: { status: string };
      events: Array<{ type: string; message: string }>;
    };
    expect(body.task.status).toBe("completed");
    const model = body.events.find((event) => event.type === "model")?.message ?? "";
    expect(model).toMatch(/1\./);
    expect(model).toMatch(/2\./);
    expect(model).toMatch(/3\./);
    expect(body.events.some((event) => event.message.includes("未对外写入"))).toBe(false);
    expect(body.events.some((event) => event.message.includes("日记"))).toBe(true);
    const diary = workspace.memory.readFile(`diaries/${todayStamp()}.md`);
    expect(diary.content).toContain("出处：task:");
  });

  it("fires a scheduled task that was due in the past, writes a diary, and leaves a terminal state", async () => {
    const now = new Date("2026-11-23T12:50:00+08:00");
    const { app, workspace, tickDueTasks } = tempApp({ now: () => now });
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "到点整理待办",
        instruction: "把今天还没做完的事列出来。",
        kind: "scheduled",
        schedule: { kind: "once", runAt: "2026-11-23T08:00", timezone: "Asia/Shanghai", enabled: true },
      }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as {
      id: string;
      status: string;
      kind: string;
      schedule?: { runAt?: string; nextRunAt?: string; kind: string };
    };
    expect(task.kind).toBe("scheduled");
    expect(task.status).toBe("scheduled");
    expect(task.schedule?.runAt).toBe("2026-11-23T08:00:00+08:00");
    expect(task.schedule?.nextRunAt).toBe("2026-11-23T08:00:00+08:00");

    const tick = await tickDueTasks(now);
    expect(tick.ranTaskIds).toContain(task.id);

    const detail = await app.request(`/api/tasks/${task.id}`);
    const body = (await detail.json()) as {
      task: { status: string; finishedAt?: string; schedule?: { enabled?: boolean } };
      events: Array<{ type: string; message: string }>;
    };
    expect(body.task.status).toBe("completed");
    expect(body.task.finishedAt).toBeTruthy();
    expect(body.task.schedule?.enabled).toBe(false);
    expect(body.events.some((event) => event.message.includes("到点"))).toBe(true);
    // 日记按注入时钟的日期落盘（2026-11-23），不能按真实今天去读。
    const diary = workspace.memory.readFile(`diaries/${todayStamp("Asia/Shanghai", now)}.md`);
    expect(diary.content).toContain(`出处：task:${task.id}`);
  });

  it("catch-up runs a missed daily task once and schedules the next future occurrence", async () => {
    let now = new Date("2026-11-22T09:00:00+08:00");
    const { app, tickDueTasks } = tempApp({ now: () => now });
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "每天早间整理",
        instruction: "每天早上把未完成的事看一遍。",
        kind: "scheduled",
        schedule: { kind: "cron", cron: "0 8 * * *", timezone: "Asia/Shanghai", enabled: true },
      }),
    });
    const task = (await created.json()) as { id: string; status: string; schedule?: { nextRunAt?: string } };
    expect(task.status).toBe("scheduled");
    expect(task.schedule?.nextRunAt).toBe("2026-11-23T08:00:00+08:00");

    now = new Date("2026-11-23T12:50:00+08:00");
    const first = await tickDueTasks(now);
    expect(first.ranTaskIds).toContain(task.id);
    const after = (await (await app.request(`/api/tasks/${task.id}`)).json()) as {
      task: { status: string; schedule?: { nextRunAt?: string } };
    };
    expect(after.task.status).toBe("scheduled");
    expect(after.task.schedule?.nextRunAt).toBe("2026-11-24T08:00:00+08:00");

    const second = await tickDueTasks(now);
    expect(second.ranTaskIds).not.toContain(task.id);
  });

  it("labels a regenerated afternoon brief as 午间, not 早间", async () => {
    const now = new Date("2026-11-23T12:41:00+08:00");
    const { app, workspace } = tempApp({ now: () => now });
    const res = await app.request("/api/today/brief", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label: string; slot: string; path: string; text: string };
    expect(body.label).toBe("午间简报");
    expect(body.label).not.toContain("早间");
    expect(body.slot).toBe("morning");
    expect(body.text).toContain("下午好");
    const file = workspace.memory.readFile(body.path);
    expect(file.content).toContain("午间简报");
    expect(file.content).not.toContain("早间简报");

    const latest = (await (await app.request("/api/today/brief")).json()) as { label: string };
    expect(latest.label).toBe("午间简报");
  });

  it("auto-generates an evening brief at the 21:00 anchor without recording fake usage", async () => {
    const now = new Date("2026-11-23T21:05:00+08:00");
    const { app, workspace, tickDueTasks } = tempApp({ now: () => now });
    await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proactivity: "anchors_only", onboardingCompleted: true }),
    });
    const first = await tickDueTasks(now);
    expect(first.briefSlot).toBe("evening");
    expect(existsSync(path.join(workspace.paths.memory, "briefs/2026-11-23-evening.md"))).toBe(true);
    const latest = (await (await app.request("/api/today/brief")).json()) as {
      label: string;
      slot: string;
      text: string;
      source?: string;
    };
    expect(latest.slot).toBe("evening");
    expect(latest.label).toBe("晚间简报");
    expect(latest.text.length).toBeGreaterThan(0);
    const usage = (await (await app.request("/api/usage/events")).json()) as { items: Array<{ purpose: string }> };
    expect(usage.items.some((item) => item.purpose === "brief")).toBe(false);
    const second = await tickDueTasks(now);
    expect(second.briefSlot).toBeUndefined();
  });

  it("does not auto-generate a brief when proactivity is off", async () => {
    const now = new Date("2026-11-23T21:05:00+08:00");
    const { workspace, tickDueTasks } = tempApp({ now: () => now });
    const result = await tickDueTasks(now);
    expect(result.briefSlot).toBeUndefined();
    expect(existsSync(path.join(workspace.paths.memory, "briefs/2026-11-23-evening.md"))).toBe(false);
  });

  it("rejects a scheduled task that is missing a time", async () => {
    const { app } = tempApp();
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "没有时间的定时",
        kind: "scheduled",
        schedule: { kind: "once", timezone: "Asia/Shanghai", enabled: true },
      }),
    });
    expect(created.status).toBe(400);
  });
});

function afternoonNow(): Date {
  return new Date("2026-11-23T15:10:00+08:00");
}

const failingModelFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ error: { message: "unavailable" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });

const LIMITED_MODEL_BODY =
  '{"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)","http_code":"429"},"request_id":"fixture-request"}';

const limitedModelFetch: typeof fetch = async () =>
  new Response(LIMITED_MODEL_BODY, { status: 429, headers: { "content-type": "application/json" } });

describe("@huoye/server provider secrets and brief source", () => {
  const fixtureKey = "fixture-workspace-key";

  async function addConfiguredProvider(app: TestApp, workspace: ReturnType<typeof tempApp>["workspace"], id = "prv_minimax_fixture") {
    const current = workspace.readSettings();
    const add = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "方陈",
        providers: [
          ...current.providers,
          {
            id,
            type: "openai_compatible",
            name: "MiniMax",
            baseUrl: "https://api.minimax.cn/v1",
            modelId: "MiniMax-M3.1-Flash",
          },
        ],
      }),
    });
    expect(add.status).toBe(200);
    const keyRes = await app.request(`/api/settings/providers/${id}/key`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: fixtureKey }),
    });
    expect(keyRes.status).toBe(200);
    const setDefault = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultProviderId: id }),
    });
    expect(setDefault.status).toBe(200);
    return id;
  }

  it("reads the model key from workspace secrets, not process.env", async () => {
    const calls: Array<{ url: string; authorization: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), authorization: headers.get("authorization") ?? "" });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "下午好，方陈。你昨晚大约睡了 6 小时，下午散了二十分钟步，心情还好。",
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 18 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await withFakeEnvKeys(async () => {
      const { app, workspace, home } = tempApp({ now: afternoonNow, fetchImpl });
      const id = await addConfiguredProvider(app, workspace);
      expect(workspace.getProviderKey(id)).toBe(fixtureKey);
      const mode = statSync(path.join(home, "secrets.json")).mode & 0o777;
      expect(mode).toBe(0o600);

      workspace.memory.appendHealthNote({
        date: "2026-11-23",
        sleep: "大约睡了 6 小时",
        movement: "下午散步 20 分钟",
        mood: "还好",
        note: "QA标记：health-ui-1",
        actor: "owner",
      });

      const res = await app.request("/api/today/brief", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        text: string;
        source: string;
        fallbackMessage?: string;
      };
      expect(body.source).toBe("model");
      expect(body.fallbackMessage).toBeUndefined();
      expect(body.text).toContain("下午好");
      expect(body.text).toContain("6 小时");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.authorization).toBe(`Bearer ${fixtureKey}`);
      expect(calls[0]?.authorization).not.toContain("must-not-be-used");
      expect(calls[0]?.url).toContain("https://api.minimax.cn/v1/chat/completions");

      const usage = (await (await app.request("/api/usage/events")).json()) as {
        items: Array<{ purpose: string; inputTokens: number; outputTokens: number }>;
      };
      const briefUsage = usage.items.find((item) => item.purpose === "brief");
      expect(briefUsage).toMatchObject({ inputTokens: 12, outputTokens: 18 });
    });
  });

  it("writes a local brief and records no usage when the default is still Mock", async () => {
    const { app } = tempApp({ now: afternoonNow });
    const res = await app.request("/api/today/brief", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; fallbackMessage?: string; text: string };
    expect(body.source).toBe("local");
    expect(body.fallbackMessage).toBeUndefined();
    expect(body.text).toContain("下午好");
    const usage = (await (await app.request("/api/usage/events")).json()) as {
      items: Array<{ purpose: string }>;
    };
    expect(usage.items.some((item) => item.purpose === "brief")).toBe(false);
  });

  it("falls back honestly in Chinese when the configured model request fails", async () => {
    await withFakeEnvKeys(async () => {
      const { app, workspace } = tempApp({ now: afternoonNow, fetchImpl: failingModelFetch });
      await addConfiguredProvider(app, workspace);
      const res = await app.request("/api/today/brief", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { source: string; fallbackMessage?: string; text: string };
      expect(body.source).toBe("local");
      expect(body.fallbackMessage).toMatch(/本地档案/);
      expect(body.fallbackMessage).not.toMatch(/\{/);
      expect(body.text).toContain("下午好");
      const usage = (await (await app.request("/api/usage/events")).json()) as {
        items: Array<{ purpose: string }>;
      };
      expect(usage.items.some((item) => item.purpose === "brief")).toBe(false);
    });
  });

  it("returns a cleaned Chinese chat error without raw provider JSON when the model is limited", async () => {
    await withFakeEnvKeys(async () => {
      const { app, workspace } = tempApp({ now: afternoonNow, fetchImpl: limitedModelFetch });
      await addConfiguredProvider(app, workspace);
      const chatId = await newChat(app);
      const res = await app.request(`/api/chats/${chatId}/messages/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "请记住：秋雾纽扣只是一句测试。" }),
      });
      expect(res.status).toBe(200);
      const events = await readSse(res);
      const failed = events.find((event) => event.type === "error");
      expect(failed).toBeTruthy();
      const message = String(failed?.error ?? "");
      expect(message).toBe(
        "模型这次没有写出来（已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)）。",
      );
      expect(message).not.toMatch(/\{/);
      expect(message).not.toContain("request_id");
      expect(message).not.toContain("fixture-request");
      expect(message).not.toContain("rate_limit_error");
      const usage = (await (await app.request("/api/usage/events")).json()) as {
        items: Array<{ purpose: string }>;
      };
      expect(usage.items.some((item) => item.purpose === "conversation")).toBe(false);
    });
  });


});
