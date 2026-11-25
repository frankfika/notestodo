import {
  ID_PREFIXES,
  chatMessageSchema,
  chatSchema,
  nowIso,
  taskRunEventSchema,
  taskSchema,
  type Chat,
  type ChatMessage,
  type Task,
  type TaskRunEvent,
} from "@huoye/schema";
import { newId, type HuoyeDb, all, get, run } from "@huoye/core";

export function listChats(db: HuoyeDb): Chat[] {
  return all<{ id: string; title: string; created_at: string; updated_at: string }>(
    db.raw,
    "SELECT * FROM chats ORDER BY updated_at DESC",
  ).map((row) =>
    chatSchema.parse({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
}

export function createChat(db: HuoyeDb, title: string, timezone: string): Chat {
  const chat = chatSchema.parse({
    id: newId(ID_PREFIXES.chat),
    title: title.trim() || "新对话",
    createdAt: nowIso(timezone),
    updatedAt: nowIso(timezone),
  });
  run(
    db.raw,
    "INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    chat.id,
    chat.title,
    chat.createdAt,
    chat.updatedAt,
  );
  return chat;
}

export function getChat(db: HuoyeDb, id: string): Chat | undefined {
  const row = get<{ id: string; title: string; created_at: string; updated_at: string }>(
    db.raw,
    "SELECT * FROM chats WHERE id = ?",
    id,
  );
  if (!row) return undefined;
  return chatSchema.parse({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function touchChat(db: HuoyeDb, id: string, timezone: string, title?: string): void {
  if (title) {
    run(db.raw, "UPDATE chats SET updated_at = ?, title = ? WHERE id = ?", nowIso(timezone), title, id);
  } else {
    run(db.raw, "UPDATE chats SET updated_at = ? WHERE id = ?", nowIso(timezone), id);
  }
}

export function listMessages(db: HuoyeDb, chatId: string): ChatMessage[] {
  return all<{
    id: string;
    chat_id: string;
    role: string;
    content: string;
    created_at: string;
    usage_event_id: string | null;
  }>(db.raw, "SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC", chatId).map((row) =>
    chatMessageSchema.parse({
      id: row.id,
      chatId: row.chat_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      usageEventId: row.usage_event_id ?? undefined,
    }),
  );
}

export function addMessage(
  db: HuoyeDb,
  input: Omit<ChatMessage, "id" | "createdAt"> & { createdAt?: string },
  timezone: string,
): ChatMessage {
  const message = chatMessageSchema.parse({
    id: newId(ID_PREFIXES.message),
    createdAt: input.createdAt ?? nowIso(timezone),
    chatId: input.chatId,
    role: input.role,
    content: input.content,
    usageEventId: input.usageEventId,
  });
  run(
    db.raw,
    "INSERT INTO chat_messages (id, chat_id, role, content, created_at, usage_event_id) VALUES (?, ?, ?, ?, ?, ?)",
    message.id,
    message.chatId,
    message.role,
    message.content,
    message.createdAt,
    message.usageEventId ?? null,
  );
  return message;
}

export function listTasks(db: HuoyeDb): Task[] {
  return all<TaskRow>(db.raw, "SELECT * FROM tasks ORDER BY updated_at DESC").map(taskFromRow);
}

export function getTask(db: HuoyeDb, id: string): Task | undefined {
  const row = get<TaskRow>(db.raw, "SELECT * FROM tasks WHERE id = ?", id);
  return row ? taskFromRow(row) : undefined;
}

export function createTask(
  db: HuoyeDb,
  input: { title: string; instruction?: string; kind?: Task["kind"]; schedule?: Task["schedule"] },
  timezone: string,
): Task {
  const kind = input.kind ?? "on_demand";
  const task = taskSchema.parse({
    id: newId(ID_PREFIXES.task),
    kind,
    title: input.title.trim(),
    instruction: input.instruction?.trim() || input.title.trim(),
    status: kind === "scheduled" ? "scheduled" : "draft",
    schedule: input.schedule,
    confirmationIds: [],
    createdAt: nowIso(timezone),
    updatedAt: nowIso(timezone),
  });
  insertTask(db, task);
  return task;
}

export function saveTask(db: HuoyeDb, task: Task): void {
  const existing = getTask(db, task.id);
  if (!existing) {
    insertTask(db, task);
    return;
  }
  run(
    db.raw,
    `UPDATE tasks SET
      kind = ?, title = ?, instruction = ?, status = ?, schedule_json = ?,
      confirmation_ids_json = ?, chat_id = ?, created_at = ?, updated_at = ?,
      started_at = ?, finished_at = ?, error_message = ?
    WHERE id = ?`,
    task.kind,
    task.title,
    task.instruction,
    task.status,
    task.schedule ? JSON.stringify(task.schedule) : null,
    JSON.stringify(task.confirmationIds),
    task.chatId ?? null,
    task.createdAt,
    task.updatedAt,
    task.startedAt ?? null,
    task.finishedAt ?? null,
    task.errorMessage ?? null,
    task.id,
  );
}

export function addRunEvent(
  db: HuoyeDb,
  input: Omit<TaskRunEvent, "id" | "at"> & { at?: string },
  timezone: string,
): TaskRunEvent {
  const event = taskRunEventSchema.parse({
    id: newId(ID_PREFIXES.event),
    at: input.at ?? nowIso(timezone),
    taskId: input.taskId,
    type: input.type,
    message: input.message,
    payload: input.payload,
  });
  run(
    db.raw,
    "INSERT INTO task_run_events (id, task_id, at, type, message, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
    event.id,
    event.taskId,
    event.at,
    event.type,
    event.message,
    event.payload ? JSON.stringify(event.payload) : null,
  );
  return event;
}

export function listRunEvents(db: HuoyeDb, taskId: string): TaskRunEvent[] {
  return all<{
    id: string;
    task_id: string;
    at: string;
    type: string;
    message: string;
    payload_json: string | null;
  }>(db.raw, "SELECT * FROM task_run_events WHERE task_id = ? ORDER BY at ASC", taskId).map((row) =>
    taskRunEventSchema.parse({
      id: row.id,
      taskId: row.task_id,
      at: row.at,
      type: row.type,
      message: row.message,
      payload: row.payload_json ? (JSON.parse(row.payload_json) as Record<string, unknown>) : undefined,
    }),
  );
}

interface TaskRow {
  id: string;
  kind: string;
  title: string;
  instruction: string;
  status: string;
  schedule_json: string | null;
  confirmation_ids_json: string;
  chat_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

function insertTask(db: HuoyeDb, task: Task): void {
  run(
    db.raw,
    `INSERT INTO tasks (
      id, kind, title, instruction, status, schedule_json, confirmation_ids_json,
      chat_id, created_at, updated_at, started_at, finished_at, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task.id,
    task.kind,
    task.title,
    task.instruction,
    task.status,
    task.schedule ? JSON.stringify(task.schedule) : null,
    JSON.stringify(task.confirmationIds),
    task.chatId ?? null,
    task.createdAt,
    task.updatedAt,
    task.startedAt ?? null,
    task.finishedAt ?? null,
    task.errorMessage ?? null,
  );
}

function taskFromRow(row: TaskRow): Task {
  return taskSchema.parse({
    id: row.id,
    kind: row.kind,
    title: row.title,
    instruction: row.instruction,
    status: row.status,
    schedule: row.schedule_json ? JSON.parse(row.schedule_json) : undefined,
    confirmationIds: JSON.parse(row.confirmation_ids_json) as string[],
    chatId: row.chat_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    errorMessage: row.error_message ?? undefined,
  });
}


export const STALE_RUNNING_MS = 30 * 60 * 1000;

/** 把已经中断、却仍停在「运行中」的任务收成终态，避免永远占着今日列表。 */
export function reapStaleRunningTasks(
  db: HuoyeDb,
  timezone: string,
  options: { now?: Date; maxAgeMs?: number; allRunning?: boolean } = {},
): Task[] {
  const now = options.now ?? new Date();
  const allRunning = options.allRunning === true;
  const maxAgeMs = options.maxAgeMs ?? STALE_RUNNING_MS;
  const reaped: Task[] = [];
  for (const task of listTasks(db)) {
    if (task.status !== "running") continue;
    const started = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
    const stale = allRunning || !Number.isFinite(started) || now.getTime() - started >= maxAgeMs;
    if (!stale) continue;
    const finished: Task = {
      ...task,
      status: "failed",
      finishedAt: nowIso(timezone),
      updatedAt: nowIso(timezone),
      errorMessage: "运行中断，已自动结束",
    };
    saveTask(db, finished);
    addRunEvent(db, { taskId: task.id, type: "status", message: "运行中断，已自动结束" }, timezone);
    reaped.push(finished);
  }
  return reaped;
}
