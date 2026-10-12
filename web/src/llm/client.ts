import type { AppSettings } from '../types'
import { resolveLLMConfig } from '../types'
import { joinUrl } from './url'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CallLLMOptions {
  jsonMode?: boolean
  maxTokens?: number
  temperature?: number
}

/**
 * Provider-agnostic LLM call. Supports:
 *   - 'openai-compatible' (OpenAI, Groq, Together, DeepSeek, etc.)
 *   - 'anthropic-compatible' (Anthropic, Anthropic-compatible proxies)
 *
 * Returns the assistant message text. On non-2xx, throws an Error whose
 * message contains the status code and a short body excerpt for debugging.
 */
export async function callLLM(
  settings: AppSettings,
  messages: ChatMessage[],
  opts: CallLLMOptions = {},
): Promise<string> {
  const jsonMode = opts.jsonMode ?? false
  const maxTokens = opts.maxTokens ?? 2048
  const temperature = opts.temperature ?? 0.2

  // Phase-2: 用 resolveLLMConfig 把 ai_mode 解析成一份「有效配置」。
  //   - 本地端点（Ollama / LM Studio / MLX）允许空 api_key —— 走 openai 兼容
  //   - 云端沿用 Phase-1 字段；空 key 报错
  const cfg = resolveLLMConfig(settings)
  if (!cfg.is_local && !cfg.api_key) {
    throw new Error('LLM API key is empty — set it in Settings.')
  }
  if (!cfg.base_url) {
    throw new Error('LLM base URL is empty — set it in Settings.')
  }
  if (!cfg.model) {
    throw new Error('LLM model is empty — set it in Settings.')
  }

  switch (cfg.provider) {
    case 'openai-compatible':
      return callOpenAICompatible(cfg, messages, {
        jsonMode,
        maxTokens,
        temperature,
      })
    case 'anthropic-compatible':
      return callAnthropicCompatible(cfg, messages, {
        jsonMode,
        maxTokens,
        temperature,
      })
    default:
      throw new Error(
        `Unsupported LLM provider: ${String(cfg.provider)}`,
      )
  }
}

// ── openai-compatible ─────────────────────────────────────────────────────────

interface OpenAIRequestBody {
  model: string
  messages: Array<{ role: string; content: string }>
  max_tokens: number
  temperature: number
  response_format?: { type: 'json_object' }
}

interface OpenAIResponse {
  choices?: Array<{
    message?: { role?: string; content?: string }
    finish_reason?: string
  }>
  error?: { message?: string; type?: string }
}

interface ResolvedLLMConfig {
  provider: 'openai-compatible' | 'anthropic-compatible'
  base_url: string
  api_key: string
  model: string
  is_local: boolean
}

async function callOpenAICompatible(
  cfg: ResolvedLLMConfig,
  messages: ChatMessage[],
  opts: { jsonMode: boolean; maxTokens: number; temperature: number },
): Promise<string> {
  const url = joinUrl(cfg.base_url, '/chat/completions')
  const body: OpenAIRequestBody = {
    model: cfg.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  }
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  // Phase-2: 本地端点（如 Ollama）经常无鉴权；空 key 时不发送 Authorization
  // —— 避免「Bearer 」被部分代理拒。
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (cfg.api_key && cfg.api_key.trim()) {
    headers.Authorization = `Bearer ${cfg.api_key}`
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `LLM request failed (${res.status} ${res.statusText}): ${truncate(text)}`,
    )
  }
  let json: OpenAIResponse
  try {
    json = JSON.parse(text) as OpenAIResponse
  } catch {
    throw new Error(`LLM returned non-JSON response: ${truncate(text)}`)
  }
  if (json.error?.message) {
    throw new Error(`LLM error: ${json.error.message}`)
  }
  const content = json.choices?.[0]?.message?.content
  if (!content) {
    throw new Error(
      `LLM returned empty content (finish_reason=${
        json.choices?.[0]?.finish_reason ?? 'unknown'
      })`,
    )
  }
  return content
}

// ── anthropic-compatible ──────────────────────────────────────────────────────

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
  error?: { message?: string; type?: string }
}

async function callAnthropicCompatible(
  cfg: ResolvedLLMConfig,
  messages: ChatMessage[],
  opts: { jsonMode: boolean; maxTokens: number; temperature: number },
): Promise<string> {
  const url = joinUrl(cfg.base_url, '/v1/messages')

  // Anthropic expects system content as a top-level `system` field,
  // not in the messages array. Extract any leading system messages
  // and concatenate them; remaining messages keep their original roles.
  const { systemParts, restMessages } = splitSystemMessages(messages)
  let systemText = systemParts.join('\n\n')
  if (opts.jsonMode) {
    systemText =
      systemText +
      (systemText ? '\n\n' : '') +
      'Return only a JSON object matching the schema. No prose, no markdown.'
  }

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: restMessages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  }
  if (systemText) {
    body.system = systemText
  }

  // 本地端点：anthropic-version 头对自建网关意义不大，但保持一致不会出错
  // —— 本期 mode='local' 强制走 openai-compatible，所以这里只在 cloud 触发。
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (cfg.api_key && cfg.api_key.trim()) {
    headers.Authorization = `Bearer ${cfg.api_key}`
  }
  if (!cfg.is_local) {
    headers['anthropic-version'] = '2023-06-01'
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `LLM request failed (${res.status} ${res.statusText}): ${truncate(text)}`,
    )
  }
  let json: AnthropicResponse
  try {
    json = JSON.parse(text) as AnthropicResponse
  } catch {
    throw new Error(`LLM returned non-JSON response: ${truncate(text)}`)
  }
  if (json.error?.message) {
    throw new Error(`LLM error: ${json.error.message}`)
  }
  const blocks = json.content ?? []
  const textBlocks = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
  const content = textBlocks.join('')
  if (!content) {
    throw new Error('LLM returned empty content')
  }
  return content
}

function splitSystemMessages(messages: ChatMessage[]): {
  systemParts: string[]
  restMessages: ChatMessage[]
} {
  const systemParts: string[] = []
  let i = 0
  while (i < messages.length && messages[i]?.role === 'system') {
    const m = messages[i]
    if (m) systemParts.push(m.content)
    i++
  }
  return { systemParts, restMessages: messages.slice(i) }
}

// ── helpers ───────────────────────────────────────────────────────────────────


function truncate(s: string, max = 400): string {
  const trimmed = s.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…`
}
