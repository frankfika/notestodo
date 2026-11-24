import { z } from "zod";

/**
 * 主动消息里的卡片。
 *
 * 一条聊天消息的正文 = 一两句人话 + 一个围栏代码块：
 *
 * ```
 * 正文文字
 *
 * ```huoye-card
 * {"kind":"brief","title":"晚间简报","actions":[{"id":"view_brief","label":"查看全文"}]}
 * ```
 * ```
 *
 * 围栏信息串固定为 `huoye-card`，卡片本体是一段 JSON。
 */

/** 围栏代码块的信息串。 */
export const PROACTIVE_CARD_INFO = "huoye-card";

/** 卡片上可以点一下的动作。点了也只是打开页面，不会替用户批准任何对外动作。 */
export const proactiveActionIdSchema = z.enum([
  "view_brief", // 打开简报全文
  "regenerate_brief", // 再整理一版（本地重生成，不对外）
  "open_confirmations", // 跳到待确认页（不自动批准）
  "view_task", // 打开任务详情
  "resume_proactive", // 恢复主动更新
]);
export type ProactiveActionId = z.infer<typeof proactiveActionIdSchema>;

export const proactiveActionSchema = z.object({
  id: proactiveActionIdSchema,
  label: z.string().min(1),
});
export type ProactiveAction = z.infer<typeof proactiveActionSchema>;

export const proactiveCardKindSchema = z.enum(["brief", "task_result", "confirmation", "paused"]);
export type ProactiveCardKind = z.infer<typeof proactiveCardKindSchema>;

export const proactiveCardSchema = z.object({
  kind: proactiveCardKindSchema,
  title: z.string().min(1),
  summary: z.string().default(""),
  briefPath: z.string().optional(),
  briefDate: z.string().optional(),
  briefSlot: z.enum(["morning", "evening"]).optional(),
  taskId: z.string().optional(),
  confirmationId: z.string().optional(),
  actions: z.array(proactiveActionSchema).default([]),
});
export type ProactiveCard = z.infer<typeof proactiveCardSchema>;

/** 匹配 ```huoye-card ... ``` 围栏块。 */
const CARD_FENCE = new RegExp("```" + PROACTIVE_CARD_INFO + "[ \\t]*\\r?\\n([\\s\\S]*?)```");

/**
 * 从一条聊天消息里拆出正文与卡片。
 * 解析失败时只返回正文，绝不抛错。
 */
export function parseProactiveCard(content: string): { text: string; card?: ProactiveCard } {
  const raw = content ?? "";
  const match = raw.match(CARD_FENCE);
  if (!match) return { text: raw.trim() };
  const text = raw.replace(match[0], "").trim();
  try {
    const parsed = proactiveCardSchema.parse(JSON.parse(match[1] ?? ""));
    return { text, card: parsed };
  } catch {
    // 卡片坏了就当普通消息处理，不让界面崩。
    return { text };
  }
}
