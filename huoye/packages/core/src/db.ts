import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 使用 Node.js 内置 `node:sqlite`（与 better-sqlite3 同样是 SQLite + FTS5）。
 * 选择原因：本环境缺少编译 better-sqlite3 所需的 make/g++，内置驱动无需原生编译。
 * Drizzle 的 schema 见 ./schema-sql.ts，查询走这里的薄封装。
 */
export class HuoyeDb {
  readonly raw: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    migrate(this.raw);
  }

  close(): void {
    this.raw.close();
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      usage_event_id TEXT,
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL,
      schedule_json TEXT,
      confirmation_ids_json TEXT NOT NULL DEFAULT '[]',
      chat_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS task_run_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS confirmations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      status TEXT NOT NULL,
      risk TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      summary TEXT NOT NULL,
      preview TEXT NOT NULL,
      editable INTEGER NOT NULL DEFAULT 1,
      tool_payload_json TEXT NOT NULL,
      task_id TEXT,
      chat_id TEXT,
      connector_id TEXT,
      executed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      purpose TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      unit_cost_in_usd REAL,
      estimated_cost_usd REAL,
      source TEXT NOT NULL,
      chat_id TEXT,
      task_id TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      refs_json TEXT,
      metadata_json TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      path,
      title,
      body,
      tokenize = 'unicode61'
    );
  `);
}

export function all<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function get<T>(db: DatabaseSync, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(db: DatabaseSync, sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]));
}
