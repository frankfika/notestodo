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
  /** 会中速记（Scribble）：短 bullet，Polish 时结合转录扩写进 note */
  error?: string
}

/**
 * 会中速记 bullet：键入即存，一行一条。
 * t_ms = 记下这条时的录音时间轴毫秒（与音频/转录对齐）；
 * 非录音状态补记的条目没有时间锚点，t_ms 为 null。
 */
export interface Scribble {
  id: ID
  meeting_id: ID
  t_ms: number | null
  text: string
  created_at: ISODateTime
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
  /** 页面树：父页面 id；null/缺省 = 根页面。会议纪要（meeting_id 非空）不进树 */
  parent_id?: ID | null
  /** 页面树同级排序，缺省按 updated_at */
  sort_order?: number
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

// ── 待办（嵌套 OKR：strategic O/KR > quarterly O/KR > project O/KR > Task）──
// 父子规则见 lib/okr.ts

export type TodoKind = 'objective' | 'kr' | 'task'
export type OkrScope = 'strategic' | 'quarterly' | 'project'
export type TodoStatus = 'open' | 'done' | 'cancelled' | 'pending_review'

export interface Todo extends EntityMeta {
  kind: TodoKind
  parent_id: ID | null       // 见 lib/okr.ts canParent；task→任意 KR 或 null（Inbox）
  /** null 仅用于 Inbox 自由任务；挂在 KR 下的 task 继承 KR 的 scope */
  scope: OkrScope | null
  /** scope==='quarterly' 时必填，如 '2026-Q4' */
  period?: string
  /** KR→O 进度汇总权重 0–1，缺省按 1 */
  weight?: number
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
  /** 看板列（done 由 status 决定）；缺省=待办 */
  board_col?: 'todo' | 'doing' | 'review'
  /** 循环卡：每周自动出现，点开即周报草稿 */
  recurring?: 'weekly-report'
}

// ── 评论（块级，锚定引文）─────────────────────────────────────────────────────

/** 块评论：anchor 用块的文本引文（块被编辑后引文可能失配，属可接受降级） */
export interface BlockComment extends EntityMeta {
  note_id: ID
  /** 评论时块的前 80 字引文，用于在页面里定位上下文 */
  quote: string
  text: string
  resolved: boolean
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

// ── 知识库 / Assist（Phase-2 item 5）────────────────────────────────────────

/** 知识库索引条目：每个 .md / .txt 一条；keyword / title 检索（见 lib/knowledge）。 */
export interface KnowledgeEntry {
  id: ID
  /** 文件夹路径（来自 settings.knowledge_folders），便于 reindex 时清理 */
  folder: string
  /** 相对路径（含文件名），UI 展示 + 后续可作"打开源文件" */
  path: string
  /** 文件名（无目录）— title 匹配的快捷源 */
  title: string
  /** 文本前 N 字符（snippet），用作卡片摘要 */
  snippet: string
  /** 完整文本（受 cap 限制），用于 keyword 检索打分 */
  fullText: string
  /** 文件 mtime（ms），reindex 时跳过未变文件 */
  mtime: number
  /** bytes，UI 调试 / 概览 */
  size_bytes: number
  created_at: ISODateTime
  updated_at: ISODateTime
  deleted_at: ISODateTime | null
  sync_version: number
}

/** 会议下 pin 住的 Assist 卡片 —— 跨 retrieve 重跑也持续显示 */
export interface PinnedAssistCard {
  id: ID
  meeting_id: ID
  /** pin 时检索结果对应的源 KnowledgeEntry id；source 删了不级联 —— 卡片保留但标灰 */
  source_entry_id: ID | null
  title: string
  snippet: string
  path: string
  created_at: ISODateTime
  updated_at: ISODateTime
  deleted_at: ISODateTime | null
  sync_version: number
}

// ── 设置（KV）───────────────────────────────────────────────────────────────

/**
 * AI 在哪里运行：
 *   'builtin' = 应用内置模型（Foresight 式，模型下载到本机、进程内推理，完全离线）
 *   'local'   = 自建本地服务（Ollama / LM Studio / whisper.cpp server 等，高级）
 *   'cloud'   = 云端 BYOK
 */
export type AiMode = 'cloud' | 'local' | 'builtin'

export interface AppSettings {
  // AI Provider（BYOK，仅存本地）
  /**
   * Phase-2: 'cloud' = 用下面的 llm_*（MiniMax / Anthropic / OpenAI 兼容网关）
   *         'local' = 用下面的 local_llm_*（Ollama / LM Studio / MLX / 自建 OpenAI 兼容）
   * 切换不会清空另一侧的字段（共存于 settings KV）。
   */
  ai_mode: AiMode
  // Cloud BYOK（ai_mode='cloud' 时生效；保留所有 Phase-1 字段不动）
  llm_provider: 'openai-compatible' | 'anthropic-compatible'
  llm_base_url: string
  llm_api_key: string
  llm_model: string
  asr_mode: AiMode   // 'builtin' = 应用内置 whisper.cpp；'local' = 自建 whisper 兼容服务；'cloud' = BYOK
  asr_provider: 'minimax' | 'openai-whisper' | 'deepgram'
  asr_base_url: string
  asr_api_key: string
  asr_model: string
  // Local LLM（ai_mode='local' 时生效；api_key 允许空——Ollama 默认无鉴权）
  local_llm_base_url: string
  local_llm_api_key: string
  local_llm_model: string
  // Local ASR（asr_mode='local' 时生效；provider 强制为 openai-whisper 兼容）
  local_asr_base_url: string
  local_asr_api_key: string
  local_asr_model: string
  // 应用内置模型（mode='builtin' 时生效）：lib/builtinModels.ts CATALOG 的 id
  builtin_llm_model: string
  builtin_asr_model: string
  /** 内置模型下载源：auto = 国内优先 OpenCSG / hf-mirror，海外优先 Hugging Face */
  model_source: 'auto' | 'huggingface' | 'hf-mirror' | 'opencsg'
  /** 常用人名 / 术语（一行一个或逗号分隔）：转录时作为热词，提高专有名词准确率 */
  hotwords: string
  // 隐私
  delete_remote_audio: boolean   // 转录完成后删除云端音频
  // 外观
  theme: 'dark' | 'light' | 'system'
  // 日历
  calendar_ics_urls: string[]
  // GitHub 导入（issues → 任务）
  github_token: string
  /** 'owner/name' 格式 */
  github_repo: string
  // 飞书导入（日历日程 → 会议壳）
  feishu_app_id: string
  feishu_app_secret: string
  // 知识库（Phase-2 item 5）— 字符串路径列表，AI 索引用的本地文件夹
  knowledge_folders: string[]
  // 开放 API（仅桌面版）：本机 HTTP 服务，Raycast / 快捷指令 / 脚本读写任务和笔记
  api_enabled: boolean
  api_port: number
  /** Bearer token；空 = 首次启用时自动生成 */
  api_token: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  ai_mode: 'cloud',
  llm_provider: 'anthropic-compatible',
  llm_base_url: 'https://api.minimax.io/anthropic',
  llm_api_key: '',
  llm_model: 'MiniMax-M2.7',
  asr_mode: 'cloud',
  asr_provider: 'minimax',
  asr_base_url: 'https://api.minimaxi.com',
  asr_api_key: '',
  asr_model: 'asr-1.0',
  local_llm_base_url: 'http://127.0.0.1:11434/v1',
  local_llm_api_key: '',
  local_llm_model: 'llama3.2',
  local_asr_base_url: 'http://127.0.0.1:8080/v1',
  local_asr_api_key: '',
  local_asr_model: 'whisper-1',
  builtin_llm_model: 'gemma-4-e4b',
  builtin_asr_model: 'whisper-large-v3-turbo',
  model_source: 'auto',
  hotwords: '',
  delete_remote_audio: true,
  theme: 'light',
  calendar_ics_urls: [],
  github_token: '',
  github_repo: '',
  feishu_app_id: '',
  feishu_app_secret: '',
  knowledge_folders: [],
  api_enabled: false,
  api_port: 17893,
  api_token: '',
}

/** Phase-2: 解析当前模式下的有效 LLM 配置。 */
export function resolveLLMConfig(s: AppSettings): {
  provider: 'openai-compatible' | 'anthropic-compatible' | 'builtin'
  base_url: string
  api_key: string
  model: string
  /** true 表示是本地端点（Ollama / LM Studio / 自建）或应用内置 — key 可空 */
  is_local: boolean
} {
  if (s.ai_mode === 'builtin') {
    return { provider: 'builtin', base_url: '', api_key: '', model: s.builtin_llm_model || DEFAULT_SETTINGS.builtin_llm_model, is_local: true }
  }
  if (s.ai_mode === 'local') {
    return {
      provider: 'openai-compatible', // 本地端点统一走 openai 兼容协议
      base_url: s.local_llm_base_url || DEFAULT_SETTINGS.local_llm_base_url,
      api_key: s.local_llm_api_key, // 允许空（Ollama）
      model: s.local_llm_model || 'llama3.2',
      is_local: true,
    }
  }
  return {
    provider: s.llm_provider,
    base_url: s.llm_base_url,
    api_key: s.llm_api_key,
    model: s.llm_model,
    is_local: false,
  }
}

/**
 * Phase-3: ASR mirror。Local 模式强制走 openai-whisper 兼容端点
 * （whisper.cpp `--inference-path`/MLX STT/faster-whisper openai-compat
 * 都暴露 POST {base}/audio/transcriptions）；api_key 允许空（whisper.cpp
 * 默认无鉴权）。切换 Cloud ↔ Local 不丢另一侧的字段。
 */
export function resolveASRConfig(s: AppSettings): {
  /** 实际调用的 provider（local 强制 openai-whisper；builtin 走应用内置 whisper.cpp） */
  provider: 'minimax' | 'openai-whisper' | 'deepgram' | 'builtin'
  base_url: string
  api_key: string
  model: string
  is_local: boolean
} {
  if (s.asr_mode === 'builtin') {
    return { provider: 'builtin', base_url: '', api_key: '', model: s.builtin_asr_model || DEFAULT_SETTINGS.builtin_asr_model, is_local: true }
  }
  if (s.asr_mode === 'local') {
    return {
      provider: 'openai-whisper',
      base_url: s.local_asr_base_url || DEFAULT_SETTINGS.local_asr_base_url,
      api_key: s.local_asr_api_key, // 允许空（whisper.cpp 默认无鉴权）
      model: s.local_asr_model || 'whisper-1',
      is_local: true,
    }
  }
  return {
    provider: s.asr_provider,
    base_url: s.asr_base_url,
    api_key: s.asr_api_key,
    model: s.asr_model,
    is_local: false,
  }
}
