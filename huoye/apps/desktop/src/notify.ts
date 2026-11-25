/**
 * 桌面系统通知的纯逻辑：只做判断和文案，不依赖 Electron，方便在 node 环境里单测。
 * 通知正文保持很短，详情留给聊天卡片和今天页。
 */

export interface DesktopNotificationItem {
  id: string;
  title: string;
  body: string;
  at: string;
  kind: string;
}

/** 通知正文最长字数（中文算一个字）。 */
export const DESKTOP_NOTIFICATION_BODY_LIMIT = 60;

const KIND_LABELS: Record<string, string> = {
  brief: "简报",
  task_result: "任务结果",
  confirmation: "待确认",
  paused: "主动更新",
};

/**
 * 只有「窗口不在前台 + 用户授权了系统通知 + 确实有待推的通知」三者同时成立才通知。
 */
export function shouldNotifyDesktop(input: { focused: boolean; permission: string; items: DesktopNotificationItem[] }): boolean {
  if (input.focused) return false;
  if (input.permission !== "granted") return false;
  if (!Array.isArray(input.items) || input.items.length === 0) return false;
  return true;
}

/** 标题带上中文前缀，用户一眼能认出是活页；缺标题时用类型兜底。 */
export function desktopNotificationTitle(item: DesktopNotificationItem): string {
  const title = (item?.title ?? "").replace(/\s+/g, " ").trim();
  const kind = (item?.kind ?? "").trim();
  const suffix = title || KIND_LABELS[kind] || "新消息";
  return `活页 · ${suffix}`;
}

/** 正文最多 60 字，超了截断并加省略号；空正文给一句中文兜底。 */
export function desktopNotificationBody(item: DesktopNotificationItem): string {
  const body = (item?.body ?? "").replace(/\s+/g, " ").trim();
  if (!body) return "有新消息，详情在活页里。";
  const chars = Array.from(body);
  if (chars.length <= DESKTOP_NOTIFICATION_BODY_LIMIT) return body;
  return `${chars.slice(0, DESKTOP_NOTIFICATION_BODY_LIMIT - 1).join("")}…`;
}
