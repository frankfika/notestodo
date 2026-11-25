import { CONFIRMATION_TTL_MS } from "@huoye/config";
import {
  ID_PREFIXES,
  confirmationRequestSchema,
  formatIso,
  nowIso,
  type ConfirmationRequest,
} from "@huoye/schema";
import type { HuoyeDb } from "./db";
import { all, get, run } from "./db";
import { newId } from "./ids";

interface ConfirmationRow {
  id: string;
  created_at: string;
  expires_at: string | null;
  status: string;
  risk: string;
  action: string;
  target: string;
  summary: string;
  preview: string;
  editable: number;
  tool_payload_json: string;
  task_id: string | null;
  chat_id: string | null;
  connector_id: string | null;
  executed_at: string | null;
}

export class ConfirmationError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "NOT_PENDING" | "EXPIRED" | "NOT_APPROVED" | "ALREADY_EXECUTED",
  ) {
    super(message);
    this.name = "ConfirmationError";
  }
}

export type ExternalWriteInput = {
  action: string;
  target: string;
  summary: string;
  preview: string;
  risk?: ConfirmationRequest["risk"];
  editable?: boolean;
  toolPayload?: Record<string, unknown>;
  taskId?: string;
  chatId?: string;
  connectorId?: string;
  expiresAt?: string;
  timezone?: string;
};

export class ConfirmationService {
  constructor(
    private readonly db: HuoyeDb,
    private readonly timezone = "Asia/Shanghai",
  ) {}

  /**
   * 对外写必须先进入待确认队列。此方法只创建 pending 记录，不执行动作。
   */
  requestExternalWrite(input: ExternalWriteInput): ConfirmationRequest {
    const tz = input.timezone ?? this.timezone;
    const createdAt = nowIso(tz);
    const expiresAt = input.expiresAt ?? formatExpiry(Date.now() + CONFIRMATION_TTL_MS, tz);
    const row: ConfirmationRequest = {
      id: newId(ID_PREFIXES.confirmation),
      createdAt,
      expiresAt,
      status: "pending",
      risk: input.risk ?? "medium",
      action: input.action,
      target: input.target,
      summary: input.summary,
      preview: input.preview,
      editable: input.editable ?? true,
      toolPayload: input.toolPayload ?? { preview: input.preview },
      taskId: input.taskId,
      chatId: input.chatId,
      connectorId: input.connectorId,
    };
    this.insert(row);
    return row;
  }

  list(includeHistory = true): ConfirmationRequest[] {
    this.sweepExpired();
    const rows = all<ConfirmationRow>(
      this.db.raw,
      `SELECT * FROM confirmations
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`,
    );
    const items = rows.map(fromRow).filter((item) => !isSeededDemoConfirmation(item));
    return includeHistory ? items : items.filter((c) => c.status === "pending");
  }

  get(id: string): ConfirmationRequest {
    this.sweepExpired();
    const row = get<ConfirmationRow>(this.db.raw, "SELECT * FROM confirmations WHERE id = ?", id);
    if (!row) throw new ConfirmationError("找不到这条确认", "NOT_FOUND");
    return fromRow(row);
  }

  approve(id: string): ConfirmationRequest {
    return this.finalize(id, "approved");
  }

  reject(id: string): ConfirmationRequest {
    return this.finalize(id, "rejected");
  }

  editAndApprove(id: string, preview: string): ConfirmationRequest {
    return this.finalize(id, "edited_approved", preview);
  }

  /**
   * 只在已批准（含编辑后批准）且未过期、未执行时真正执行。
   * 未批准或已过期不得执行。
   */
  execute<T>(id: string, handler: (request: ConfirmationRequest) => T): T {
    const request = this.get(id);
    if (request.status === "expired" || request.status === "rejected") {
      throw new ConfirmationError("已拒绝或已过期的确认不得执行", "EXPIRED");
    }
    if (request.status !== "approved" && request.status !== "edited_approved") {
      throw new ConfirmationError("未批准不得执行", "NOT_APPROVED");
    }
    const row = get<ConfirmationRow>(this.db.raw, "SELECT * FROM confirmations WHERE id = ?", id);
    if (row?.executed_at) {
      throw new ConfirmationError("这条确认已经执行过了", "ALREADY_EXECUTED");
    }
    const result = handler(request);
    run(this.db.raw, "UPDATE confirmations SET executed_at = ? WHERE id = ?", nowIso(this.timezone), id);
    return result;
  }

  sweepExpired(): void {
    const rows = all<ConfirmationRow>(
      this.db.raw,
      "SELECT * FROM confirmations WHERE status = 'pending' AND expires_at IS NOT NULL",
    );
    const now = Date.now();
    for (const row of rows) {
      if (row.expires_at && Date.parse(row.expires_at) <= now) {
        run(this.db.raw, "UPDATE confirmations SET status = 'expired' WHERE id = ?", row.id);
      }
    }
  }

  /** 新工作区不再自动种演示确认。已有工作区里未处理的演示条目会过期，也不再出现在待确认列表里。 */
  expireSeededDemos(): void {
    const rows = all<ConfirmationRow>(this.db.raw, "SELECT * FROM confirmations WHERE status = 'pending'");
    for (const row of rows) {
      if (isSeededDemoConfirmation(fromRow(row))) {
        run(this.db.raw, "UPDATE confirmations SET status = 'expired' WHERE id = ?", row.id);
      }
    }
  }

  seedDemoIfEmpty(): ConfirmationRequest | undefined {
    const existing = get<{ c: number }>(this.db.raw, "SELECT COUNT(*) AS c FROM confirmations");
    if ((existing?.c ?? 0) > 0) return undefined;
    return this.requestExternalWrite({
      action: "demo.message.send",
      target: "演示会话",
      summary: "拟发送一条消息",
      preview: "你好，这是一条演示消息，批准后也不会真的发到外部。",
      risk: "low",
      editable: true,
      toolPayload: { text: "你好，这是一条演示消息，批准后也不会真的发到外部。" },
    });
  }

  private finalize(
    id: string,
    status: "approved" | "rejected" | "edited_approved",
    preview?: string,
  ): ConfirmationRequest {
    const request = this.get(id);
    if (request.status === "expired") {
      throw new ConfirmationError("已过期视为拒绝，不得再批准或执行", "EXPIRED");
    }
    if (request.status !== "pending") {
      throw new ConfirmationError("只有待处理的确认可以批准或拒绝", "NOT_PENDING");
    }
    const nextPreview = preview ?? request.preview;
    const payload =
      preview !== undefined ? { ...request.toolPayload, preview, text: preview } : request.toolPayload;
    run(
      this.db.raw,
      "UPDATE confirmations SET status = ?, preview = ?, tool_payload_json = ? WHERE id = ?",
      status,
      nextPreview,
      JSON.stringify(payload),
      id,
    );
    return this.get(id);
  }

  private insert(row: ConfirmationRequest): void {
    confirmationRequestSchema.parse(row);
    run(
      this.db.raw,
      `INSERT INTO confirmations (
        id, created_at, expires_at, status, risk, action, target, summary, preview,
        editable, tool_payload_json, task_id, chat_id, connector_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.createdAt,
      row.expiresAt ?? null,
      row.status,
      row.risk,
      row.action,
      row.target,
      row.summary,
      row.preview,
      row.editable ? 1 : 0,
      JSON.stringify(row.toolPayload),
      row.taskId ?? null,
      row.chatId ?? null,
      row.connectorId ?? null,
    );
  }
}

function fromRow(row: ConfirmationRow): ConfirmationRequest {
  return confirmationRequestSchema.parse({
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    status: row.status,
    risk: row.risk,
    action: row.action,
    target: row.target,
    summary: row.summary,
    preview: row.preview,
    editable: Boolean(row.editable),
    toolPayload: JSON.parse(row.tool_payload_json) as Record<string, unknown>,
    taskId: row.task_id ?? undefined,
    chatId: row.chat_id ?? undefined,
    connectorId: row.connector_id ?? undefined,
  });
}

function formatExpiry(ts: number, timeZone: string): string {
  return formatIso(new Date(ts), timeZone);
}

/** 启动时自动种下的演示确认，不应出现在新用户的待确认徽章里。 */
export function isSeededDemoConfirmation(item: { action: string; chatId?: string; target: string }): boolean {
  return item.action === "demo.message.send" && !item.chatId && item.target === "演示会话";
}
