import type {
  Chat,
  ChatMessage,
  ConfirmationRequest,
  MemoryFile,
  MemorySearchHit,
  MemoryTreeNode,
  Proactivity,
  Settings,
  Task,
  TaskRunEvent,
  UsageEvent,
  UsageSummary,
  AuditEvent,
} from "@huoye/schema";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_REQUEST_ERROR = "请求没有成功，请稍后再试。";
const DEFAULT_BRIEF_ERROR = "简报没有整理成功，请稍后再试。";

export async function readFailedResponse(response: Response, fallback = DEFAULT_REQUEST_ERROR): Promise<{
  message: string;
  body?: unknown;
}> {
  const raw = await response.text();
  let body: unknown = raw;
  if (raw) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = raw;
    }
  }
  const fromObject =
    typeof body === "object" && body && "error" in body && typeof (body as { error: unknown }).error === "string"
      ? String((body as { error: string }).error).trim()
      : "";
  const message = fromObject || fallback;
  return { message, body };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const fallback = path.includes("/api/today/brief") ? DEFAULT_BRIEF_ERROR : DEFAULT_REQUEST_ERROR;
    const { message, body } = await readFailedResponse(response, fallback);
    throw new ApiError(message, response.status, body);
  }
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return (await response.json()) as T;
  return (await response.arrayBuffer()) as T;
}

export async function uploadRecording(file: File, source: "upload" | "browser" = "upload"): Promise<UploadRecordingResult> {
  const form = new FormData();
  form.set("file", file);
  form.set("source", source);
  const response = await fetch("/api/recordings", { method: "POST", body: form });
  if (!response.ok) {
    const { message, body } = await readFailedResponse(response);
    throw new ApiError(message, response.status, body);
  }
  return (await response.json()) as UploadRecordingResult;
}

export const api = {
  health: () => request<{ ok: boolean; name: string }>("/api/health"),
  workspace: () => request<{ home: string; memory: string; config: string }>("/api/workspace"),
  settings: () => request<Settings>("/api/settings"),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),
  saveKey: (id: string, key: string) =>
    request<Settings>(`/api/settings/providers/${id}/key`, { method: "PUT", body: JSON.stringify({ key }) }),
  deleteProvider: (id: string) =>
    request<Settings>(`/api/settings/providers/${id}`, { method: "DELETE" }),
  connectors: () => request<{ items: ConnectorView[] }>("/api/connectors"),
  channels: () => request<{ items: ChannelView[] }>("/api/channels"),
  saveChannel: (id: string, values: Record<string, string>) =>
    request<ChannelView>(`/api/channels/${id}`, { method: "PUT", body: JSON.stringify(values) }),
  removeChannel: (id: string) => request<ChannelView>(`/api/channels/${id}`, { method: "DELETE" }),
  addFolder: (path: string) =>
    request<{ roots: string[]; folders: LocalFolderView[] }>("/api/connectors/local-folders", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  removeFolder: (path: string) =>
    request<{ roots: string[]; folders: LocalFolderView[] }>("/api/connectors/local-folders", {
      method: "DELETE",
      body: JSON.stringify({ path }),
    }),
  folderListing: (path: string) =>
    request<LocalFolderListing>(`/api/connectors/local-folders/listing?path=${encodeURIComponent(path)}`),
  tree: () => request<{ tree: MemoryTreeNode[] }>("/api/memory/tree"),
  memoryFolder: (path: string) =>
    request<MemoryTreeNode>(`/api/memory/folder?path=${encodeURIComponent(path)}`),
  aboutYou: () => request<{ markdown: string; files: MemoryFile[] }>("/api/memory/about-you"),
  memoryFile: (path: string) => request<MemoryFile>(`/api/memory/file?path=${encodeURIComponent(path)}`),
  saveMemoryFile: (path: string, content: string, expectedRevision: string) =>
    request<MemoryFile>(`/api/memory/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      body: JSON.stringify({ content, expectedRevision }),
    }),
  deleteMemoryFile: (path: string) =>
    request<{ ok: boolean }>(`/api/memory/file?path=${encodeURIComponent(path)}`, { method: "DELETE" }),
  mkdir: (path: string) => request<{ ok: boolean }>("/api/memory/mkdir", { method: "POST", body: JSON.stringify({ path }) }),
  rename: (from: string, to: string) =>
    request<{ ok: boolean }>("/api/memory/rename", { method: "POST", body: JSON.stringify({ from, to }) }),
  pin: (path: string, pinned: boolean) =>
    request<MemoryFile>("/api/memory/pin", { method: "POST", body: JSON.stringify({ path, pinned }) }),
  activities: () => request<{ items: Array<{ id: string; at: string; message: string; path: string }> }>("/api/memory/activities"),
  search: (q: string) => request<{ hits: MemorySearchHit[] }>(`/api/memory/search?q=${encodeURIComponent(q)}`),
  chats: () => request<{ items: Chat[] }>("/api/chats"),
  createChat: (title?: string) => request<Chat>("/api/chats", { method: "POST", body: JSON.stringify({ title }) }),
  messages: (id: string) => request<{ chat: Chat; items: ChatMessage[] }>(`/api/chats/${id}/messages`),
  tasks: () => request<{ items: Task[] }>("/api/tasks"),
  createTask: (input: { title: string; instruction?: string; kind?: "on_demand" | "scheduled"; schedule?: Task["schedule"] }) =>
    request<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  task: (id: string) => request<{ task: Task; events: TaskRunEvent[] }>(`/api/tasks/${id}`),
  runTask: (id: string) => request<{ task: Task; events: TaskRunEvent[] }>(`/api/tasks/${id}/run`, { method: "POST" }),
  cancelTask: (id: string) => request<{ task: Task }>(`/api/tasks/${id}/cancel`, { method: "POST" }),
  confirmations: () => request<{ items: ConfirmationRequest[] }>("/api/confirmations"),
  approve: (id: string) =>
    request<{ item: ConfirmationRequest; executed?: ExecutedResult }>(`/api/confirmations/${id}/approve`, {
      method: "POST",
    }),
  reject: (id: string) => request<{ item: ConfirmationRequest }>(`/api/confirmations/${id}/reject`, { method: "POST" }),
  editAndApprove: (id: string, preview: string) =>
    request<{ item: ConfirmationRequest; executed?: ExecutedResult }>(
      `/api/confirmations/${id}/edit-and-approve`,
      {
        method: "POST",
        body: JSON.stringify({ preview }),
      },
    ),
  usageSummary: () => request<UsageSummary>("/api/usage/summary"),
  usageEvents: () => request<{ items: UsageEvent[] }>("/api/usage/events"),
  audit: () => request<{ items: AuditEvent[] }>("/api/audit"),
  brief: () => request<BriefResponse>("/api/today/brief", { method: "POST" }),
  latestBrief: () => request<BriefResponse>("/api/today/brief"),
  todayCards: () => request<TodayCards>("/api/today/cards"),
  healthNotes: () => request<HealthNotesPayload>("/api/health-notes"),
  saveHealthNote: (input: { sleep?: string; movement?: string; mood?: string; note?: string }) =>
    request<HealthNotesPayload>("/api/health-notes", { method: "POST", body: JSON.stringify(input) }),
  recordings: () => request<RecordingsPayload>("/api/recordings"),
  recording: (id: string) =>
    request<{ item: RecordingItem; transcribeConfigured: boolean; meetings: { status: string; label: string } }>(
      `/api/recordings/${id}`,
    ),
  saveRecordingNote: (id: string, content: string, expectedRevision: string) =>
    request<{ item: RecordingItem }>(`/api/recordings/${id}/note`, {
      method: "PUT",
      body: JSON.stringify({ content, expectedRevision }),
    }),
  uploadRecording,
  exportUrl: "/api/export/memory.zip",
  notes: (q: string, scope: NoteScope = "all") =>
    request<NoteListPayload>(`/api/notes?q=${encodeURIComponent(q)}&scope=${encodeURIComponent(scope)}`),
  noteFile: (path: string) => request<NoteDetail>(`/api/notes/file?path=${encodeURIComponent(path)}`),
  saveNote: (path: string, body: string, expectedRevision: string, title?: string) =>
    request<{ file: MemoryFile; body: string; revision: string }>("/api/notes/file", {
      method: "PUT",
      body: JSON.stringify({ path, body, expectedRevision, title }),
    }),
  createNote: (input: { title?: string; body?: string; date?: string }) =>
    request<{ file: MemoryFile; path: string; href: string }>("/api/notes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  toggleNoteTodo: (path: string, index: number) =>
    request<{ file: MemoryFile; body: string; revision: string; todos: NoteTodo[] }>("/api/notes/todo", {
      method: "POST",
      body: JSON.stringify({ path, index }),
    }),
  summarizeMeeting: (input: { transcript?: string; recordingId?: string; title?: string }) =>
    request<MeetingSummaryResponse>("/api/meetings/summarize", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /* 主动性：状态、已读、恢复、通知。路径与 docs/PROACTIVE-ROUND-CONTRACT.md 一致。 */
  proactiveState: () => request<ProactiveStateView>("/api/proactive/state"),
  markProactiveRead: () =>
    request<{ ok: boolean; state: ProactiveStateView }>("/api/proactive/read", { method: "POST" }),
  resumeProactive: () =>
    request<{ ok: boolean; state: ProactiveStateView }>("/api/proactive/resume", { method: "POST" }),
  notifications: () => request<{ items: ProactiveNotification[] }>("/api/proactive/notifications"),
  ackNotifications: () => request<{ ok: boolean }>("/api/proactive/notifications/ack", { method: "POST" }),
};

export interface ProactiveNotification {
  id: string;
  title: string;
  body: string;
  at: string;
  kind: string;
}

export interface ProactiveStateView {
  /** 当前档位：off / anchors_only / calendar_changes / allowed_news。 */
  proactivity: Proactivity;
  /** 连着几天没读而被暂停。 */
  paused: boolean;
  pausedAt: string | null;
  /** 上一次没读到的起点；null 表示都读过了。 */
  unreadSince: string | null;
  lastReadAt: string | null;
  /** 待确认条数：服务端可能给数字，也可能给列表。 */
  pendingConfirmations: number | unknown[];
}

export type NoteScope = "all" | "diary" | "meeting" | "note" | "health";
export type NoteKind = "diary" | "meeting" | "note" | "health" | "other";

export interface NoteItem {
  path: string;
  title: string;
  kind: NoteKind;
  snippet: string;
  score: number;
  updatedAt: string;
  href: string;
}

export interface NoteListPayload {
  scope: NoteScope;
  query: string;
  total: number;
  items: NoteItem[];
}

export interface NoteLink {
  target: string;
  resolved: boolean;
  path?: string;
  title?: string;
}

export interface NoteDetail {
  file: MemoryFile;
  /** 正文，不含 YAML 头。 */
  body: string;
  frontmatter: Record<string, unknown>;
  revision: string;
  links: NoteLink[];
  backlinks: Array<{ path: string; title: string; href: string }>;
}

export interface NoteTodo {
  index: number;
  done: boolean;
  text: string;
}

export interface MeetingSummaryResponse {
  ok: boolean;
  message: string;
  title: string;
  body: string;
  todos: Array<{ text: string; source: string }>;
  path: string;
  href: string;
  confirmations: ConfirmationRequest[];
}

export interface ExecutedResult {
  ok: boolean;
  message: string;
}

export interface BriefResponse {
  text: string;
  generatedAt: string | null;
  slot?: "morning" | "evening";
  source?: "model" | "local";
  path?: string;
  label?: string;
  nextAnchor?: { slot: "morning" | "evening"; hour: number; label: string };
  fallbackMessage?: string;
}

export interface LocalFolderView {
  path: string;
  status: "connected" | "error";
  error?: string;
}

export interface LocalFolderEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
  outside?: boolean;
}

export interface LocalFolderListing {
  path: string;
  status: "connected" | "error";
  error?: string;
  entries: LocalFolderEntry[];
  truncated?: boolean;
}

export interface ConnectorView {
  id: string;
  name: string;
  kind: "cloud" | "local" | "channel";
  status: "not_connected" | "connected" | "error";
  capabilities: Array<"read" | "write" | "send">;
  description: string;
  roots?: string[];
  folders?: LocalFolderView[];
}

export interface ChannelFieldView {
  key: string;
  label: string;
  type: "text" | "secret";
  required: boolean;
  placeholder: string;
  help?: string;
  /** 公开字段回显当前值。 */
  value?: string;
  /** 密钥字段只回显是否已配置。 */
  configured?: boolean;
}

export interface ChannelView {
  id: string;
  name: string;
  kind: "channel";
  status: "not_connected" | "connected" | "error";
  description: string;
  setupHint: string;
  eventPath: string;
  capabilities: Array<"read" | "send">;
  fields: ChannelFieldView[];
}

export interface ConflictBody {
  error: "conflict";
  current: { revision: string; snippet: string; content: string };
  incoming: { expectedRevision: string; snippet: string; content: string };
}

export async function streamChat(
  chatId: string,
  content: string,
  onDelta: (text: string) => void,
): Promise<{ messageId?: string; text: string; memory?: StreamMemory }> {
  const response = await fetch(`/api/chats/${chatId}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok || !response.body) {
    let message = "发送失败";
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let messageId: string | undefined;
  let memory: StreamMemory | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((item) => item.startsWith("data:"));
      if (!line) continue;
      const data = JSON.parse(line.slice(5).trim()) as {
        type: string;
        text?: string;
        messageId?: string;
        error?: string;
        memory?: StreamMemory;
      };
      if (data.type === "delta" && data.text) {
        full += data.text;
        onDelta(data.text);
      }
      if (data.type === "done") {
        messageId = data.messageId;
        if (data.text) full = data.text;
        if (data.memory) memory = data.memory;
      }
      if (data.type === "error") throw new Error(data.error || "生成失败");
    }
  }
  return { messageId, text: full, memory };
}

export interface StreamMemory {
  diaryAppended: boolean;
  diaryPath?: string;
  /** 聊天里「写一页笔记」落地后的那一页。 */
  note?: { title: string; path: string; href: string };
  error?: string;
  confirmations: ConfirmationRequest[];
}

export interface HealthNoteToday {
  date: string;
  exists: boolean;
  path: string;
  title?: string;
  summary: string;
  content: string;
  revision?: string;
}

export interface HealthNoteItem {
  date: string;
  path: string;
  title: string;
  summary: string;
  updatedAt: string;
}

export interface HealthNotesPayload {
  date: string;
  today: HealthNoteToday;
  items: HealthNoteItem[];
  wearables: Array<{ id: string; name: string; status: "not_connected" | "connected" }>;
  file?: unknown;
}

export interface RecordingItem {
  id: string;
  title: string;
  originalName: string;
  status: "transcribed" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
  path: string;
  summary: string;
  content: string;
  revision: string;
  bytes?: number;
  durationMs?: number | null;
  playable?: boolean;
  audioError?: string;
}

export interface RecordingsPayload {
  items: RecordingItem[];
  transcribeConfigured: boolean;
  meetings: { status: "not_connected" | "connected"; label: string };
}

export interface UploadRecordingResult {
  item: RecordingItem;
  transcribe: { ok: boolean; unconfigured?: boolean; error?: string; text?: string };
}

export interface TodayCards {
  health: { date: string; hasToday: boolean; summary: string; path: string };
  recordings: {
    count: number;
    todayCount: number;
    latest: RecordingItem | null;
  };
  transcribeConfigured: boolean;
}
