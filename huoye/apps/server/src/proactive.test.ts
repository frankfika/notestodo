import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseProactiveCard } from "@huoye/schema";
import { createApp } from "./app";
import { listChats, listMessages } from "./records";
import {
  pendingNotifications,
  pushBriefToChat,
  readProactiveState,
} from "./proactive";

/**
 * 活页主动来找你：服务端这一侧的验收。
 * 时间全部冻结在固定时刻，不依赖真实时间。
 */

const TZ = "Asia/Shanghai";
const ANCHOR = new Date("2026-11-23T21:05:00+08:00");

function tempApp(options: { now?: () => Date; fetchImpl?: typeof fetch } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "huoye-proactive-"));
  const created = createApp({ home, now: options.now, fetchImpl: options.fetchImpl });
  return { app: created.app, workspace: created.workspace, home, tickDueTasks: created.tickDueTasks };
}

async function putSettings(app: ReturnType<typeof tempApp>["app"], body: Record<string, unknown>) {
  const res = await app.request("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

/** 打开主动（只到锚点提醒）。 */
async function enableAnchors(app: ReturnType<typeof tempApp>["app"]) {
  const res = await putSettings(app, { proactivity: "anchors_only", onboardingCompleted: true });
  expect(res.status).toBe(200);
}

/** 主对话里的消息（没有对话时返回空数组）。 */
function chatMessages(workspace: ReturnType<typeof tempApp>["workspace"]) {
  const chat = listChats(workspace.db)[0];
  return chat ? listMessages(workspace.db, chat.id) : [];
}

function cardsOf(messages: ReturnType<typeof chatMessages>) {
  return messages.map((message) => parseProactiveCard(message.content));
}

async function createScheduledTask(app: ReturnType<typeof tempApp>["app"], title: string) {
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      instruction: "把今天还没做完的事列出来。",
      kind: "scheduled",
      schedule: { kind: "once", runAt: "2026-11-23T08:00", timezone: TZ, enabled: true },
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; title: string };
}

/** 装一个一定失败的模型，用来验证任务失败也会回写。 */
async function addFailingProvider(
  app: ReturnType<typeof tempApp>["app"],
  workspace: ReturnType<typeof tempApp>["workspace"],
) {
  const current = workspace.readSettings();
  const id = "prv_failure_fixture";
  const add = await putSettings(app, {
    providers: [
      ...current.providers,
      {
        id,
        type: "openai_compatible",
        name: "故障模型",
        baseUrl: "https://example.invalid/v1",
        modelId: "fixture",
      },
    ],
  });
  expect(add.status).toBe(200);
  const key = await app.request(`/api/settings/providers/${id}/key`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "fixture-key" }),
  });
  expect(key.status).toBe(200);
  const setDefault = await putSettings(app, { defaultProviderId: id });
  expect(setDefault.status).toBe(200);
}

const failingModelFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ error: { message: "unavailable" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });

describe("@huoye/server 主动消息", () => {
  it("anchors_only 到了锚点：既有简报文件，主对话里也有一条带卡片的助理消息", async () => {
    const { app, workspace, tickDueTasks } = tempApp({ now: () => ANCHOR });
    await enableAnchors(app);

    const tick = await tickDueTasks(ANCHOR);
    expect(tick.briefSlot).toBe("evening");
    expect(tick.briefPushed).toBe(true);
    expect(existsSync(path.join(workspace.paths.memory, "briefs/2026-11-23-evening.md"))).toBe(true);

    const messages = chatMessages(workspace);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toContain("```huoye-card");

    const [parsed] = cardsOf(messages);
    expect(parsed?.text).not.toContain("huoye-card");
    expect(parsed?.card?.kind).toBe("brief");
    expect(parsed?.card?.briefSlot).toBe("evening");
    expect(parsed?.card?.briefPath).toBe("briefs/2026-11-23-evening.md");
    const actions = parsed?.card?.actions.map((action) => action.id) ?? [];
    expect(actions).toContain("view_brief");
    expect(actions).toContain("regenerate_brief");
  });

  it("主动关着（off）：不整理简报，也不往聊天里写任何东西", async () => {
    const { workspace, tickDueTasks } = tempApp({ now: () => ANCHOR });

    const tick = await tickDueTasks(ANCHOR);
    expect(tick.briefSlot).toBeUndefined();
    expect(tick.briefPushed).toBeUndefined();
    expect(existsSync(path.join(workspace.paths.memory, "briefs/2026-11-23-evening.md"))).toBe(false);
    expect(listChats(workspace.db)).toEqual([]);
    expect(chatMessages(workspace)).toEqual([]);
    expect(pendingNotifications(workspace)).toEqual([]);
  });

  it("同一个锚点只推一次：再跑一次也不会多写一条", async () => {
    const { app, workspace, tickDueTasks } = tempApp({ now: () => ANCHOR });
    await enableAnchors(app);

    await tickDueTasks(ANCHOR);
    await tickDueTasks(ANCHOR);
    expect(chatMessages(workspace)).toHaveLength(1);

    const again = pushBriefToChat(
      workspace,
      { text: "再整理一版", slot: "evening", label: "晚间简报" },
      ANCHOR,
      TZ,
    );
    expect(again).toEqual({ pushed: false, reason: "duplicate" });
    expect(chatMessages(workspace)).toHaveLength(1);
  });

  it("定时任务跑完：结果回写到主对话", async () => {
    const { app, workspace, tickDueTasks } = tempApp({ now: () => ANCHOR });
    await enableAnchors(app);
    const task = await createScheduledTask(app, "到点整理待办");

    const tick = await tickDueTasks(ANCHOR);
    expect(tick.ranTaskIds).toContain(task.id);

    const card = cardsOf(chatMessages(workspace)).find((item) => item.card?.kind === "task_result");
    expect(card?.card?.taskId).toBe(task.id);
    expect(card?.card?.title).toContain("跑完");
    expect(card?.card?.actions.map((action) => action.id)).toContain("view_task");
  });

  it("定时任务失败：也会回写失败说明", async () => {
    const { app, workspace, tickDueTasks } = tempApp({ now: () => ANCHOR, fetchImpl: failingModelFetch });
    await enableAnchors(app);
    await addFailingProvider(app, workspace);
    const task = await createScheduledTask(app, "到点整理待办");

    await tickDueTasks(ANCHOR);

    const card = cardsOf(chatMessages(workspace)).find((item) => item.card?.kind === "task_result");
    expect(card?.card?.taskId).toBe(task.id);
    expect(card?.card?.title).toContain("没能跑完");
    expect(card?.card?.summary.length).toBeGreaterThan(0);
    expect(card?.text).toContain("没能跑完");
  });

  it("新的待确认：主对话里留一条可点提醒，仍然要用户点头才执行", async () => {
    const { app, workspace } = tempApp({ now: () => ANCHOR });
    await enableAnchors(app);

    const res = await app.request("/api/confirmations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "channel.message.send",
        target: "张三",
        summary: "给张三发一条消息",
        preview: "今天有空吗？",
      }),
    });
    expect(res.status).toBe(201);
    const item = (await res.json()) as { id: string; status: string };

    const messages = chatMessages(workspace);
    expect(messages).toHaveLength(1);
    const [parsed] = cardsOf(messages);
    expect(parsed?.card?.kind).toBe("confirmation");
    expect(parsed?.card?.confirmationId).toBe(item.id);
    expect(parsed?.card?.actions.map((action) => action.id)).toEqual(["open_confirmations"]);
    expect(parsed?.text).toContain("等你确认");

    // 只是提醒：确认仍然是待确认，没有被执行。
    const list = (await (await app.request("/api/confirmations")).json()) as {
      items: Array<{ id: string; status: string }>;
    };
    expect(list.items.find((entry) => entry.id === item.id)?.status).toBe("pending");
  });

  it("连续三天没读：暂停主动推送并留下说明，恢复后继续", async () => {
    const { app, workspace, tickDueTasks } = tempApp({ now: () => ANCHOR });
    await enableAnchors(app);

    await tickDueTasks(ANCHOR);
    expect(chatMessages(workspace)).toHaveLength(1);
    expect(readProactiveState(workspace).paused).toBe(false);
    expect(readProactiveState(workspace).unreadSince).toBeTruthy();

    const later = new Date("2026-11-26T21:05:00+08:00");
    const tick = await tickDueTasks(later);
    expect(tick.briefSlot).toBeUndefined();
    expect(tick.briefPushed).toBeUndefined();
    expect(readProactiveState(workspace).paused).toBe(true);
    expect(existsSync(path.join(workspace.paths.memory, "briefs/2026-11-26-evening.md"))).toBe(false);

    const messages = chatMessages(workspace);
    expect(messages).toHaveLength(2);
    const notice = cardsOf(messages)[1];
    expect(notice?.card?.kind).toBe("paused");
    expect(notice?.card?.actions.map((action) => action.id)).toContain("resume_proactive");

    // 恢复后继续推。
    const resumed = await app.request("/api/proactive/resume", { method: "POST" });
    expect(resumed.status).toBe(200);
    expect(readProactiveState(workspace).paused).toBe(false);

    const after = await tickDueTasks(later);
    expect(after.briefPushed).toBe(true);
    expect(existsSync(path.join(workspace.paths.memory, "briefs/2026-11-26-evening.md"))).toBe(true);
  });

  it("引导完成后默认 anchors_only；已经选过 off 的工作区不被覆盖", async () => {
    const { app, workspace } = tempApp();
    expect(workspace.readSettings().proactivity).toBe("off");
    expect(workspace.readSettings().onboardingCompleted).toBe(false);

    const done = await putSettings(app, { displayName: "方陈", assistantName: "叶", onboardingCompleted: true });
    expect(done.status).toBe(200);
    expect(workspace.readSettings().proactivity).toBe("anchors_only");
    expect(workspace.readSettings().onboardingCompleted).toBe(true);

    // 已经完成引导的工作区，改别的设置不会被拽回 anchors_only。
    const keep = await putSettings(app, { proactivity: "off" });
    expect(keep.status).toBe(200);
    expect(workspace.readSettings().proactivity).toBe("off");
    const again = await putSettings(app, { displayName: "方陈" });
    expect(again.status).toBe(200);
    expect(workspace.readSettings().proactivity).toBe("off");
  });

  it("引导时自己选了 off 就照 off 算", async () => {
    const { app, workspace } = tempApp();
    const res = await putSettings(app, { onboardingCompleted: true, proactivity: "off" });
    expect(res.status).toBe(200);
    expect(workspace.readSettings().proactivity).toBe("off");
  });

  it("主动关着时，待确认也不留提醒", async () => {
    const { app, workspace } = tempApp({ now: () => ANCHOR });
    const res = await app.request("/api/confirmations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "channel.message.send", summary: "给张三发一条消息" }),
    });
    expect(res.status).toBe(201);
    expect(chatMessages(workspace)).toEqual([]);
    expect(pendingNotifications(workspace)).toEqual([]);
  });

  it("还有待确认时，简报卡片上多一个「去确认」", async () => {
    const { app, workspace } = tempApp({ now: () => ANCHOR });
    await enableAnchors(app);
    const res = await app.request("/api/confirmations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "channel.message.send", summary: "给张三发一条消息" }),
    });
    expect(res.status).toBe(201);

    const pushed = pushBriefToChat(
      workspace,
      { text: "晚间简报整理好了。", slot: "evening", label: "晚间简报" },
      ANCHOR,
      TZ,
    );
    expect(pushed.pushed).toBe(true);

    const brief = cardsOf(chatMessages(workspace)).find((item) => item.card?.kind === "brief");
    expect(brief?.card?.actions.map((action) => action.id)).toContain("open_confirmations");
  });

  it("主动状态的接口能读到状态、标记已读、清掉通知", async () => {    const { app, workspace } = tempApp({ now: () => ANCHOR });
    await enableAnchors(app);
    await pushBriefToChat(
      workspace,
      { text: "晚间简报整理好了。", slot: "evening", label: "晚间简报", path: "briefs/2026-11-23-evening.md" },
      ANCHOR,
      TZ,
    );

    const state = (await (await app.request("/api/proactive/state")).json()) as {
      proactivity: string;
      paused: boolean;
      unreadSince: string | null;
      lastReadAt: string | null;
      pendingConfirmations: number;
    };
    expect(state.proactivity).toBe("anchors_only");
    expect(state.paused).toBe(false);
    expect(state.unreadSince).toBeTruthy();
    expect(state.lastReadAt).toBeNull();
    expect(state.pendingConfirmations).toBe(0);

    const notifications = (await (await app.request("/api/proactive/notifications")).json()) as {
      items: Array<{ title: string; body: string; kind: string }>;
    };
    expect(notifications.items).toHaveLength(1);
    expect(notifications.items[0].kind).toBe("brief");
    expect(notifications.items[0].body.length).toBeLessThanOrEqual(60);

    const read = await app.request("/api/proactive/read", { method: "POST" });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { ok: boolean; state: { unreadSince: string | null } };
    expect(readBody.ok).toBe(true);
    expect(readBody.state.unreadSince).toBeNull();

    const ack = await app.request("/api/proactive/notifications/ack", { method: "POST" });
    expect(ack.status).toBe(200);
    expect(pendingNotifications(workspace)).toEqual([]);
  });
});
