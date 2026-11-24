import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Drizzle 表定义，与 db.ts 中的 DDL 对齐。运行时查询目前走 node:sqlite 薄封装。 */
export const usageEvents = sqliteTable("usage_events", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  purpose: text("purpose").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  totalTokens: integer("total_tokens").notNull(),
  unitCostInUsd: real("unit_cost_in_usd"),
  estimatedCostUsd: real("estimated_cost_usd"),
  source: text("source").notNull(),
  chatId: text("chat_id"),
  taskId: text("task_id"),
});

export const confirmations = sqliteTable("confirmations", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  status: text("status").notNull(),
  risk: text("risk").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  summary: text("summary").notNull(),
  preview: text("preview").notNull(),
  editable: integer("editable").notNull(),
  toolPayloadJson: text("tool_payload_json").notNull(),
  taskId: text("task_id"),
  chatId: text("chat_id"),
  connectorId: text("connector_id"),
  executedAt: text("executed_at"),
});
