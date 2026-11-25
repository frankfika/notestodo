import { ID_PREFIXES, nowIso, type AuditEvent } from "@huoye/schema";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { HuoyeDb } from "./db";
import { all, run } from "./db";
import { newId } from "./ids";

export function recordAudit(
  db: HuoyeDb,
  event: Omit<AuditEvent, "id" | "at"> & { at?: string },
  options?: { timezone?: string; jsonlPath?: string },
): AuditEvent {
  const full: AuditEvent = {
    id: newId(ID_PREFIXES.audit),
    at: event.at ?? nowIso(options?.timezone ?? "Asia/Shanghai"),
    actor: event.actor,
    type: event.type,
    summary: event.summary,
    refs: event.refs,
    metadata: event.metadata,
  };
  run(
    db.raw,
    `INSERT INTO audit_events (id, at, actor, type, summary, refs_json, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    full.id,
    full.at,
    full.actor,
    full.type,
    full.summary,
    full.refs ? JSON.stringify(full.refs) : null,
    full.metadata ? JSON.stringify(full.metadata) : null,
  );
  if (options?.jsonlPath) {
    mkdirSync(path.dirname(options.jsonlPath), { recursive: true });
    appendFileSync(options.jsonlPath, `${JSON.stringify(full)}\n`, "utf8");
  }
  return full;
}

export function listAudit(
  db: HuoyeDb,
  limit = 50,
  cursor?: string,
): { items: AuditEvent[]; nextCursor?: string } {
  const rows = all<{
    id: string;
    at: string;
    actor: string;
    type: string;
    summary: string;
    refs_json: string | null;
    metadata_json: string | null;
  }>(
    db.raw,
    cursor
      ? "SELECT * FROM audit_events WHERE at < (SELECT at FROM audit_events WHERE id = ?) OR (at = (SELECT at FROM audit_events WHERE id = ?) AND id < ?) ORDER BY at DESC, id DESC LIMIT ?"
      : "SELECT * FROM audit_events ORDER BY at DESC, id DESC LIMIT ?",
    ...(cursor ? [cursor, cursor, cursor, limit] : [limit]),
  );
  const items: AuditEvent[] = rows.map((row) => ({
    id: row.id,
    at: row.at,
    actor: row.actor as AuditEvent["actor"],
    type: row.type,
    summary: row.summary,
    refs: row.refs_json ? (JSON.parse(row.refs_json) as string[]) : undefined,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined,
  }));
  const last = items[items.length - 1];
  return { items, nextCursor: items.length === limit && last ? last.id : undefined };
}
