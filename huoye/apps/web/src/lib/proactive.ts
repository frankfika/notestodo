import { PROACTIVE_CARD_INFO, parseProactiveCard as parseSharedCard } from "@huoye/schema";
import type {
  ProactiveAction,
  ProactiveActionId,
  ProactiveCard,
  ProactiveCardKind,
} from "@huoye/schema";
import type { ProactiveNotification } from "./api";

/**
 * 主动消息的卡片解析与纯逻辑辅助。
 *
 * 卡片格式由 docs/PROACTIVE-ROUND-CONTRACT.md 定死：聊天消息正文 + 一个
 * ```huoye-card 围栏，围栏里是 JSON。解析的主路径是 @huoye/schema 里的共享实现，
 * 本模块只补一层兜底与界面用的纯逻辑，不碰 DOM、不发请求。
 */

export { PROACTIVE_CARD_INFO };
export type { ProactiveAction, ProactiveActionId, ProactiveCard, ProactiveCardKind };

/** 合同里的 5 个动作 id。按钮只做「打开 / 再生成 / 跳过去」，不代替用户拍板。 */
export const PROACTIVE_ACTION_IDS: readonly ProactiveActionId[] = [
  "view_brief",
  "regenerate_brief",
  "open_confirmations",
  "view_task",
  "resume_proactive",
];

export const PROACTIVE_CARD_KINDS: readonly ProactiveCardKind[] = [
  "brief",
  "task_result",
  "confirmation",
  "paused",
];

function isActionId(value: unknown): value is ProactiveActionId {
  return typeof value === "string" && (PROACTIVE_ACTION_IDS as readonly string[]).includes(value);
}

function isCardKind(value: unknown): value is ProactiveCardKind {
  return typeof value === "string" && (PROACTIVE_CARD_KINDS as readonly string[]).includes(value);
}

/** 把任意来源的卡片数据收敛成能安全渲染的形状；不合格就当没有卡片。 */
export function normalizeCard(value: unknown): ProactiveCard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!isCardKind(raw.kind)) return undefined;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return undefined;
  const actions: ProactiveAction[] = [];
  if (Array.isArray(raw.actions)) {
    for (const item of raw.actions) {
      if (!item || typeof item !== "object") continue;
      const action = item as Record<string, unknown>;
      if (!isActionId(action.id)) continue;
      const label = typeof action.label === "string" ? action.label.trim() : "";
      if (!label) continue;
      actions.push({ id: action.id, label });
    }
  }
  const card: ProactiveCard = {
    kind: raw.kind,
    title,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    actions,
  };
  if (typeof raw.briefPath === "string" && raw.briefPath.trim()) card.briefPath = raw.briefPath.trim();
  if (typeof raw.briefDate === "string" && raw.briefDate.trim()) card.briefDate = raw.briefDate.trim();
  if (raw.briefSlot === "morning" || raw.briefSlot === "evening") card.briefSlot = raw.briefSlot;
  if (typeof raw.taskId === "string" && raw.taskId.trim()) card.taskId = raw.taskId.trim();
  if (typeof raw.confirmationId === "string" && raw.confirmationId.trim()) {
    card.confirmationId = raw.confirmationId.trim();
  }
  return card;
}

function matchFenceOpen(line: string): { marker: string; info: string } | null {
  const match = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
  if (!match) return null;
  return { marker: match[1][0], info: match[2].trim() };
}

function isFenceClose(line: string, marker: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed[0] !== marker) return false;
  return /^(`{3,}|~{3,})$/.test(trimmed);
}

/**
 * 本地兜底解析：按合同从消息里摘出卡片围栏，剩下的人话当正文。永远不抛错。
 * 共享实现出问题时才用得上，规则与它一致。
 */
export function parseLocalCard(content: string): { text: string; card?: ProactiveCard } {
  const source = typeof content === "string" ? content : "";
  const lines = source.split("\n");
  const kept: string[] = [];
  let card: ProactiveCard | undefined;
  let index = 0;
  while (index < lines.length) {
    const open = matchFenceOpen(lines[index]);
    if (!open || open.info !== PROACTIVE_CARD_INFO) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }
    const body: string[] = [];
    let cursor = index + 1;
    let closed = false;
    while (cursor < lines.length) {
      if (isFenceClose(lines[cursor], open.marker)) {
        closed = true;
        break;
      }
      body.push(lines[cursor]);
      cursor += 1;
    }
    if (!closed) {
      // 围栏没合上：当作普通正文留着，不动它。
      kept.push(lines[index]);
      index += 1;
      continue;
    }
    if (!card) {
      const parsed = parseCardJson(body.join("\n"));
      if (parsed) card = parsed;
    }
    index = cursor + 1;
  }
  const text = kept.join("\n").trim();
  return card ? { text, card } : { text };
}

function parseCardJson(raw: string): ProactiveCard | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return normalizeCard(value);
  } catch {
    // 非法 JSON：只当没有卡片，正文照常给出去。
    return undefined;
  }
}

/**
 * 拆一条聊天消息：正文 + 可选的主动卡片。
 * 主路径是 @huoye/schema 的共享实现；它要是抛错，就退回本地实现。
 * 解析失败只返回正文，绝不抛错。
 */
export function parseProactiveCard(content: string): { text: string; card?: ProactiveCard } {
  try {
    const result = parseSharedCard(content);
    return { text: typeof result?.text === "string" ? result.text : "", card: result?.card };
  } catch {
    return parseLocalCard(content);
  }
}

/** 服务端没给动作时，按卡片类型补一组最保守的按钮。 */
export function defaultActionsFor(card: ProactiveCard): ProactiveAction[] {
  switch (card.kind) {
    case "brief":
      return [
        { id: "view_brief", label: "查看全文" },
        { id: "regenerate_brief", label: "再整理一版" },
      ];
    case "task_result":
      return [{ id: "view_task", label: "查看任务" }];
    case "confirmation":
      return [{ id: "open_confirmations", label: "去确认" }];
    case "paused":
      return [{ id: "resume_proactive", label: "恢复主动更新" }];
    default:
      return [];
  }
}

/** 卡片种类的小标签，用来区分这是简报、任务结果还是待确认。 */
export function proactiveKindLabel(kind: ProactiveCardKind): string {
  switch (kind) {
    case "brief":
      return "简报";
    case "task_result":
      return "任务结果";
    case "confirmation":
      return "待确认";
    case "paused":
      return "已暂停";
    default:
      return "主动消息";
  }
}

/**
 * 网页端弹系统通知的条件：页面不在前台、浏览器支持、用户已授权，而且确实有新通知。
 * 没授权就安静跳过，绝不主动索要权限。
 */
export function shouldNotifyWeb(input: {
  hidden: boolean;
  supported: boolean;
  permission: string;
  items: unknown[];
}): boolean {
  if (!input.supported) return false;
  if (input.permission !== "granted") return false;
  if (!input.hidden) return false;
  return input.items.length > 0;
}

/** 取最新的一条通知。 */
export function newestNotification(items: ProactiveNotification[]): ProactiveNotification | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  let newest: ProactiveNotification | undefined;
  for (const item of items) {
    if (!newest || String(item.at ?? "") > String(newest.at ?? "")) newest = item;
  }
  return newest;
}

/** 服务端的待确认条数可能是数字，也可能是列表，这里统一成一个数字。 */
export function pendingConfirmationCount(value: number | unknown[] | undefined | null): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (Array.isArray(value)) return value.length;
  return 0;
}
