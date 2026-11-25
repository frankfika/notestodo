import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newId } from "@huoye/core";
import {
  ID_PREFIXES,
  PROACTIVE_CARD_INFO,
  formatIso,
  proactiveCardSchema,
  type Chat,
  type ProactiveCard,
} from "@huoye/schema";
import { addMessage, createChat, getChat, listChats, touchChat } from "./records";
import { dateInZone } from "./helpers";
import type { Workspace } from "./workspace";

/**
 * 活页主动来找你：到锚点整理简报、定时任务跑完、有新的待确认，
 * 都在同一个主对话里留一条助理消息（正文 + 卡片）。
 *
 * 主动不等于自治：这里写的任何卡片按钮都只负责「打开某个页面」，
 * 不会替用户批准任何对外动作。
 */

/** 连着几天没读到主动消息就暂停主动推送。 */
export const PROACTIVE_PAUSE_AFTER_DAYS = 3;

/** 状态文件名，写在工作区的 data 目录里。 */
export const PROACTIVE_STATE_FILENAME = "proactive-state.json";

/** 通知正文最多 60 字，桌面端直接拿这句话弹通知。 */
const NOTIFICATION_BODY_LIMIT = 60;

/** 通知列表最多留这么多条，多的丢掉最旧的。 */
const NOTIFICATION_LIMIT = 20;

export interface ProactiveNotification {
  id: string;
  title: string;
  body: string;
  at: string;
  kind: string;
}

export interface ProactiveState {
  /** 去重键 -> 推送时间。简报用「日期|锚点」，确认用「confirmation|确认 id」。 */
  pushedAnchors: Record<string, string>;
  /** 上次已读时间；null 表示现在没有未读。 */
  unreadSince: string | null;
  /** 连续几天没读就置为 true，之后不再主动推。 */
  paused: boolean;
  pausedAt: string | null;
  /** 暂停说明是不是已经在聊天里留过了。 */
  pauseNoticeAt: string | null;
  lastReadAt: string | null;
  notifications: ProactiveNotification[];
}

export function defaultProactiveState(): ProactiveState {
  return {
    pushedAnchors: {},
    unreadSince: null,
    paused: false,
    pausedAt: null,
    pauseNoticeAt: null,
    lastReadAt: null,
    notifications: [],
  };
}

/* ------------------------------------------------------------------ *
 * 状态文件
 * ------------------------------------------------------------------ */

export function proactiveStatePath(workspace: Workspace): string {
  return path.join(workspace.paths.data, PROACTIVE_STATE_FILENAME);
}

/** 读状态：文件不存在或坏了都返回默认状态，不抛错。 */
export function readProactiveState(workspace: Workspace): ProactiveState {
  const file = proactiveStatePath(workspace);
  if (!existsSync(file)) return defaultProactiveState();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ProactiveState> | null;
    if (!raw || typeof raw !== "object") return defaultProactiveState();
    const base = defaultProactiveState();
    return {
      pushedAnchors:
        raw.pushedAnchors && typeof raw.pushedAnchors === "object"
          ? Object.fromEntries(
              Object.entries(raw.pushedAnchors).filter(([, value]) => typeof value === "string"),
            )
          : base.pushedAnchors,
      unreadSince: typeof raw.unreadSince === "string" ? raw.unreadSince : null,
      paused: raw.paused === true,
      pausedAt: typeof raw.pausedAt === "string" ? raw.pausedAt : null,
      pauseNoticeAt: typeof raw.pauseNoticeAt === "string" ? raw.pauseNoticeAt : null,
      lastReadAt: typeof raw.lastReadAt === "string" ? raw.lastReadAt : null,
      notifications: Array.isArray(raw.notifications)
        ? raw.notifications.filter(
            (item): item is ProactiveNotification =>
              Boolean(item) && typeof item === "object" && typeof item.id === "string",
          )
        : base.notifications,
    };
  } catch {
    return defaultProactiveState();
  }
}

export function writeProactiveState(workspace: Workspace, state: ProactiveState): void {
  const file = proactiveStatePath(workspace);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ *
 * 主对话
 * ------------------------------------------------------------------ */

/** 取最近更新的那个对话；一个都没有时新建一个「主动消息」对话。 */
export function ensureProactiveChat(workspace: Workspace, timezone: string): Chat {
  const existing = listChats(workspace.db)[0];
  if (existing) return existing;
  return createChat(workspace.db, "主动消息", timezone);
}

/* ------------------------------------------------------------------ *
 * 推送
 * ------------------------------------------------------------------ */

/** 到点简报 → 聊天里一条助理消息（卡片 kind="brief"）。同一天同一锚点只推一次。 */
export function pushBriefToChat(
  workspace: Workspace,
  brief: {
    text: string;
    path?: string;
    slot: "morning" | "evening";
    label: string;
    nextAnchor?: { label: string };
  },
  now: Date,
  timezone: string,
): { pushed: boolean; reason?: "duplicate" | "paused" | "off" } {
  if (isQuiet(workspace)) return { pushed: false, reason: "off" };
  const state = evaluateProactivePause(workspace, now, timezone);
  if (state.paused) return { pushed: false, reason: "paused" };
  const key = anchorKey(now, timezone, brief.slot);
  if (state.pushedAnchors[key]) return { pushed: false, reason: "duplicate" };

  const digest = briefDigest(brief.text);
  const card: ProactiveCard = {
    kind: "brief",
    title: brief.label,
    summary: digest,
    ...(brief.path ? { briefPath: brief.path } : {}),
    briefDate: dateInZone(now, timezone),
    briefSlot: brief.slot,
    actions: [
      { id: "view_brief", label: "查看全文" },
      { id: "regenerate_brief", label: "再整理一版" },
      ...(hasPendingConfirmations(workspace)
        ? [{ id: "open_confirmations" as const, label: "去确认" }]
        : []),
    ],
  };
  const lines = [`${brief.label}整理好了。`];
  if (brief.nextAnchor?.label) lines.push(`下一次是${brief.nextAnchor.label}。`);
  writeProactiveMessage(workspace, timezone, lines.join(""), card);

  const stamp = formatIso(now, timezone);
  state.pushedAnchors[key] = stamp;
  if (!state.unreadSince) state.unreadSince = stamp;
  pushNotification(state, {
    title: brief.label,
    body: digest,
    at: stamp,
    kind: "brief",
  });
  writeProactiveState(workspace, state);
  return { pushed: true };
}

/** 定时任务跑完 → 回写同一主对话（卡片 kind="task_result"）。 */
export function pushTaskResultToChat(
  workspace: Workspace,
  input: { title: string; ok: boolean; summary: string; taskId: string; chatId?: string },
  now: Date,
  timezone: string,
): { pushed: boolean } {
  if (isQuiet(workspace)) return { pushed: false };
  const state = evaluateProactivePause(workspace, now, timezone);
  if (state.paused) return { pushed: false };

  const card: ProactiveCard = {
    kind: "task_result",
    title: input.ok ? "任务跑完了" : "任务没能跑完",
    summary: input.summary,
    taskId: input.taskId,
    actions: [{ id: "view_task", label: "查看任务" }],
  };
  const text = input.ok
    ? `任务「${input.title}」跑完了。`
    : `任务「${input.title}」没能跑完：${input.summary}`;
  const target = input.chatId ? getChat(workspace.db, input.chatId) : undefined;
  writeProactiveMessage(workspace, timezone, text, card, target);

  const stamp = formatIso(now, timezone);
  if (!state.unreadSince) state.unreadSince = stamp;
  pushNotification(state, {
    title: input.title,
    body: input.summary,
    at: stamp,
    kind: "task_result",
  });
  writeProactiveState(workspace, state);
  return { pushed: true };
}

/** 新的待确认请求 → 聊天里一条可点提醒（卡片 kind="confirmation"），仍需用户确认。 */
export function notifyPendingConfirmation(
  workspace: Workspace,
  request: { id: string; summary: string; action?: string; chatId?: string },
  now: Date,
  timezone: string,
): { pushed: boolean } {
  if (isQuiet(workspace)) return { pushed: false };
  const state = evaluateProactivePause(workspace, now, timezone);
  if (state.paused) return { pushed: false };
  const key = `confirmation|${request.id}`;
  if (state.pushedAnchors[key]) return { pushed: false };

  const card: ProactiveCard = {
    kind: "confirmation",
    title: "有一条要你确认",
    summary: request.summary,
    confirmationId: request.id,
    actions: [{ id: "open_confirmations", label: "去确认" }],
  };
  const text = `有一条要对外的动作等你确认：${request.summary}。等你确认后才会执行。`;
  const target = request.chatId ? getChat(workspace.db, request.chatId) : undefined;
  writeProactiveMessage(workspace, timezone, text, card, target);

  const stamp = formatIso(now, timezone);
  state.pushedAnchors[key] = stamp;
  if (!state.unreadSince) state.unreadSince = stamp;
  pushNotification(state, {
    title: "有待确认",
    body: request.summary,
    at: stamp,
    kind: "confirmation",
  });
  writeProactiveState(workspace, state);
  return { pushed: true };
}

/* ------------------------------------------------------------------ *
 * 暂停 / 已读 / 恢复
 * ------------------------------------------------------------------ */

/**
 * 推送前先看要不要暂停：上次主动消息到现在已经过了三天以上，就先歇着。
 * 第一次触发暂停时在聊天里留一条说明，之后不再重复留。
 */
export function evaluateProactivePause(
  workspace: Workspace,
  now: Date,
  timezone: string,
): ProactiveState {
  const state = readProactiveState(workspace);
  if (state.paused) return state;
  const since = state.unreadSince ? new Date(state.unreadSince) : null;
  if (!since || Number.isNaN(since.getTime())) return state;
  const days = dayDiff(dateInZone(since, timezone), dateInZone(now, timezone));
  if (days < PROACTIVE_PAUSE_AFTER_DAYS) return state;

  const next: ProactiveState = { ...state, paused: true, pausedAt: formatIso(now, timezone) };
  if (!next.pauseNoticeAt) {
    try {
      writeProactiveMessage(workspace, timezone, pauseNoticeText(), pauseNoticeCard());
      next.pauseNoticeAt = next.pausedAt;
    } catch {
      // 说明写不进去就先记下暂停，下次再试。
    }
  }
  writeProactiveState(workspace, next);
  return next;
}

/** 用户打开/已读：清掉未读起点，记录已读时间。 */
export function markProactiveRead(workspace: Workspace, now: Date): ProactiveState {
  const timezone = workspaceTimezone(workspace);
  const state = readProactiveState(workspace);
  const next: ProactiveState = {
    ...state,
    unreadSince: null,
    lastReadAt: formatIso(now, timezone),
  };
  writeProactiveState(workspace, next);
  return next;
}

/** 一点恢复：取消暂停，清掉未读起点。不发消息。 */
export function resumeProactive(workspace: Workspace, now: Date): ProactiveState {
  void now;
  const state = readProactiveState(workspace);
  const next: ProactiveState = {
    ...state,
    paused: false,
    pausedAt: null,
    pauseNoticeAt: null,
    unreadSince: null,
  };
  writeProactiveState(workspace, next);
  return next;
}

/* ------------------------------------------------------------------ *
 * 通知
 * ------------------------------------------------------------------ */

export function pendingNotifications(workspace: Workspace): ProactiveState["notifications"] {
  return readProactiveState(workspace).notifications;
}

export function acknowledgeNotifications(workspace: Workspace): void {
  const state = readProactiveState(workspace);
  if (!state.notifications.length) return;
  writeProactiveState(workspace, { ...state, notifications: [] });
}

/* ------------------------------------------------------------------ *
 * 给界面看的状态
 * ------------------------------------------------------------------ */

export interface ProactiveStateView {
  proactivity: string;
  paused: boolean;
  pausedAt: string | null;
  unreadSince: string | null;
  lastReadAt: string | null;
  /** 现在有多少条待确认。 */
  pendingConfirmations: number;
}

export function proactiveStateView(
  workspace: Workspace,
  state: ProactiveState = readProactiveState(workspace),
): ProactiveStateView {
  return {
    proactivity: workspace.readSettings().proactivity ?? "off",
    paused: state.paused,
    pausedAt: state.pausedAt,
    unreadSince: state.unreadSince,
    lastReadAt: state.lastReadAt,
    pendingConfirmations: pendingConfirmationCount(workspace),
  };
}

/* ------------------------------------------------------------------ *
 * 内部
 * ------------------------------------------------------------------ */

/** 主动彻底关掉时，什么都不写、什么都不发。 */
function isQuiet(workspace: Workspace): boolean {
  return (workspace.readSettings().proactivity ?? "off") === "off";
}

function workspaceTimezone(workspace: Workspace): string {
  return workspace.readSettings().timezone || "Asia/Shanghai";
}

function anchorKey(now: Date, timezone: string, slot: "morning" | "evening"): string {
  return `${dateInZone(now, timezone)}|${slot}`;
}

function hasPendingConfirmations(workspace: Workspace): boolean {
  return pendingConfirmationCount(workspace) > 0;
}

function pendingConfirmationCount(workspace: Workspace): number {
  try {
    return workspace.confirmations.list(false).length;
  } catch {
    return 0;
  }
}

/** 把正文和卡片拼成一条聊天消息：正文在前，卡片围栏在后。 */
export function buildProactiveContent(text: string, card: ProactiveCard): string {
  const body = (text ?? "").trim();
  const json = JSON.stringify(proactiveCardSchema.parse(card));
  return `${body}\n\n\`\`\`${PROACTIVE_CARD_INFO}\n${json}\n\`\`\``;
}

function writeProactiveMessage(
  workspace: Workspace,
  timezone: string,
  text: string,
  card: ProactiveCard,
  target?: Chat,
): void {
  const chat = target ?? ensureProactiveChat(workspace, timezone);
  addMessage(
    workspace.db,
    { chatId: chat.id, role: "assistant", content: buildProactiveContent(text, card) },
    timezone,
  );
  touchChat(workspace.db, chat.id, timezone);
}

function pushNotification(
  state: ProactiveState,
  input: { title: string; body: string; at: string; kind: string },
): void {
  const item: ProactiveNotification = {
    id: newId(ID_PREFIXES.notification),
    title: input.title,
    body: truncate(input.body ?? "", NOTIFICATION_BODY_LIMIT),
    at: input.at,
    kind: input.kind,
  };
  state.notifications = [...state.notifications, item].slice(-NOTIFICATION_LIMIT);
}

function truncate(text: string, limit: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, limit)}…`;
}

/** 简报的短要点：去掉日期行，压成一行，截断到 120 字。 */
function briefDigest(text: string, limit = 120): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const stop = flat.search(/[。！？]/);
  const head = stop >= 0 ? flat.slice(0, stop + 1) : "";
  const rest = /\d{1,2}月\d{1,2}日/.test(head) ? flat.slice(stop + 1).trim() : flat;
  const body = rest || flat;
  return body.length > limit ? `${body.slice(0, limit)}…` : body;
}

function pauseNoticeText(): string {
  return "连着几天没读到我的消息，我先歇一会儿。想让我继续，点一下「恢复主动更新」就行。";
}

function pauseNoticeCard(): ProactiveCard {
  return {
    kind: "paused",
    title: "主动更新已暂停",
    summary: "连着几天没读到主动消息，先不再打扰你。",
    actions: [{ id: "resume_proactive", label: "恢复主动更新" }],
  };
}

/** 两个「YYYY-MM-DD」之间差几天。 */
function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
