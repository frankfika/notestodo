// ── 拾贝 Shibei · 数据模型（docs/DESIGN.md §4.2）────────────────────────────

export type ID = string

export type ISODateTime = string
export type ISODate = string

/** 所有实体的公共字段（同步前置：软删除 + 版本） */
interface EntityMeta {
  id: ID
  created_at: ISODateTime
  updated_at: ISODateTime
  deleted_at: ISODateTime | null
  sync_version: number
}

// ── 会议 ─────────────────────────────────────────────────────────────────────

export type MeetingStatus =
  | 'recording'
  | 'processing'      // 录音结束，排队/转录中
  | 'transcribed'     // 转录完成
  | 'summarizing'     // 正在生成纪要
  | 'summarized'      // 全部完成
  | 'failed'

export type MeetingSource = 'manual' | 'calendar' | 'feishu' | 'tencent'

export interface Meeting extends EntityMeta {
  title: string
  calendar_event_id?: string
  source: MeetingSource
  status: MeetingStatus
  started_at: ISODateTime
  ended_at?: ISODateTime
  /** 音频统一元信息；分片 blob 存 audioChunks 表 */
  audio: {
    format: string      // 'audio/webm' | 'audio/mp4' | ...
    codec: string       // 'opus' | 'aac'
    duration_ms: number
    chunk_count: number
    size_bytes: number
    /** 中断产生的空档（转录时知晓即可，MVP 直接拼接） */
    gaps: [number, number][]
  }
  note_id: ID
  error?: string
}

/** 录音分片，按 seq 排序拼接即完整录音 */
export interface AudioChunk {
  id: ID
  meeting_id: ID
  seq: number
  blob: Blob
  size_bytes: number
  duration_ms: number
  created_at: ISODateTime
}

// ── 转录 ─────────────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  start_ms: number
  end_ms: number
  speaker_label: string     // 初始「说话人 1」，可改名
  text: string
}

export interface Transcript extends EntityMeta {
  meeting_id: ID
  language: string
  engine: string            // 'minimax-asr' | 'deepgram' | ...
  engine_meta?: Record<string, unknown>
  segments: TranscriptSegment[]
  /** 说话人映射（本会议内）：{ '说话人 1': '张三' } */
  speaker_names: Record<string, string>
}

// ── 笔记 / 纪要 ──────────────────────────────────────────────────────────────

export interface Note extends EntityMeta {
  title: string
  body_md: string
  meeting_id?: ID
  todo_ids: ID[]
  pinned: boolean
}

export interface Summary extends EntityMeta {
  meeting_id: ID
  template_id: ID
  content_md: string
  raw_llm_output: unknown
  generated_at: ISODateTime
  model: string
}

// ── 模板 ─────────────────────────────────────────────────────────────────────

export interface SummaryTemplate extends EntityMeta {
  name: string
  icon: string
  prompt_md: string          // 含 {{变量}}
  is_default: boolean
  builtin: boolean
}

// ── 待办（三级：Objective > KR > Task）───────────────────────────────────────

export type TodoKind = 'objective' | 'kr' | 'task'
export type TodoStatus = 'open' | 'done' | 'cancelled' | 'pending_review'

export interface Todo extends EntityMeta {
  kind: TodoKind
  parent_id: ID | null       // kr→objective；task→kr 或 null（自由 task）
  title: string
  notes_md?: string
  status: TodoStatus
  due_date?: ISODate
  start_date?: ISODate
  assignee?: string          // 委派人员（团队协作预留，MVP 纯文本存值）
  source: 'manual' | 'meeting' | 'note'
  meeting_id?: ID
  origin_note_id?: ID
  /** 出处引文：可定位到转录段 */
  transcript_span?: { start_ms: number; end_ms: number; quote: string }
  sort_order: number
}

// ── 标签 ─────────────────────────────────────────────────────────────────────

export interface Tag extends EntityMeta {
  name: string
  color: string
}

export interface TagBinding extends EntityMeta {
  tag_id: ID
  target_type: 'todo' | 'note' | 'meeting'
  target_id: ID
}

// ── AI 对话（挂在会议下）──────────────────────────────────────────────────────

export interface ChatMessage extends EntityMeta {
  meeting_id: ID
  role: 'user' | 'assistant'
  content: string
  /** 回答中引用的转录段 */
  citations?: { start_ms: number; end_ms: number }[]
}

// ── 处理队列（断网重试等）────────────────────────────────────────────────────

export interface QueueJob extends EntityMeta {
  type: 'transcribe' | 'summarize' | 'chat'
  meeting_id?: ID
  payload: Record<string, unknown>
  status: 'pending' | 'running' | 'done' | 'failed'
  attempts: number
  last_error?: string
}

// ── 设置（KV）───────────────────────────────────────────────────────────────

export interface AppSettings {
  // AI Provider（BYOK，仅存本地）
  llm_provider: 'openai-compatible' | 'anthropic-compatible'
  llm_base_url: string
  llm_api_key: string
  llm_model: string
  asr_provider: 'minimax' | 'openai-whisper' | 'deepgram'
  asr_base_url: string
  asr_api_key: string
  asr_model: string
  // 隐私
  delete_remote_audio: boolean   // 转录完成后删除云端音频
  // 外观
  theme: 'dark' | 'light' | 'system'
  // 日历
  calendar_ics_urls: string[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  llm_provider: 'anthropic-compatible',
  llm_base_url: 'https://api.minimax.io/anthropic',
  llm_api_key: '',
  llm_model: 'MiniMax-M2.7',
  asr_provider: 'minimax',
  asr_base_url: 'https://api.minimaxi.com',
  asr_api_key: '',
  asr_model: 'asr-1.0',
  delete_remote_audio: true,
  theme: 'dark',
  calendar_ics_urls: [],
}
