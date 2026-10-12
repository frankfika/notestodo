/**
 * 设置页「测试连接」— BYOK 的关键信任闭环。
 *
 * 用户填完 key 只能等第一场会议转录/总结才知道对错；这里把验证前置。
 * 策略按 provider 分层（全部为免费/近零成本请求，不产生转录计费）：
 *
 *   LLM:
 *     - openai-compatible  → GET /models（免费元数据端点）
 *     - anthropic-compatible → POST /messages max_tokens=1（各家兼容网关无 /models，
 *       实测 MiniMax 网关返回 401/400 区分鉴权与参数错误；正常 key 返回 200）
 *   ASR:
 *     - minimax   → 对 /v1/speech_to_text 发空 body：无 key 1004 鉴权错，
 *       有 key 会进参数校验（≠鉴权错即视为 key 有效）
 *     - deepgram  → GET /v1/projects（免费管理端点，实测无效 key 返回
 *       {"category":"UNAUTHORIZED"} 401）
 *     - openai-whisper → GET {base}/models（OpenAI 兼容元数据端点）
 */

import type { AppSettings } from '../types'
import { resolveLLMConfig } from '../types'
import { joinUrl } from './url'

export interface TestResult {
  ok: boolean
  /** 展示给用户的一句话结论（中文） */
  message: string
}

const TIMEOUT_MS = 15_000

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function testLLMConnection(settings: AppSettings): Promise<TestResult> {
  // Phase-2: 用 resolveLLMConfig 解析；本地端点允许空 api_key
  const cfg = resolveLLMConfig(settings)
  if (!cfg.is_local && !cfg.api_key) {
    return { ok: false, message: '未填写 API Key' }
  }
  if (!cfg.base_url) return { ok: false, message: '未填写 Base URL' }
  try {
    let res: Response
    if (cfg.provider === 'openai-compatible') {
      // 本地端点也用 /models 探活；Ollama 实现 /v1/models 返回已下载模型列表
      const headers: Record<string, string> = {}
      if (cfg.api_key && cfg.api_key.trim()) {
        headers.Authorization = `Bearer ${cfg.api_key}`
      }
      res = await fetchWithTimeout(joinUrl(cfg.base_url, '/models'), { headers })
    } else {
      // anthropic-compatible：最小 messages 调用（max_tokens=1）。
      // 关键：只用 safelist 头（Authorization + text/plain）→ 简单请求不触发 CORS
      // 预检。带 anthropic-version 的预检 POST 在部分代理环境会 ERR_FAILED（实测），
      // 而网关鉴权层不依赖该头 — 401/200 的鉴权语义完全保留，且与主调用一致用 Bearer。
      const headers: Record<string, string> = { 'Content-Type': 'text/plain' }
      if (cfg.api_key && cfg.api_key.trim()) {
        headers.Authorization = `Bearer ${cfg.api_key}`
      }
      res = await fetchWithTimeout(joinUrl(cfg.base_url, '/v1/messages'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      })
    }
    if (res.ok) return { ok: true, message: `连接成功（HTTP ${res.status}）` }
    const body = await res.text()
    return { ok: false, message: `HTTP ${res.status}：${body.slice(0, 140)}` }
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.name === 'AbortError' ? '连接超时' : `网络错误：${String(e)}` }
  }
}

export async function testASRConnection(settings: AppSettings): Promise<TestResult> {
  if (!settings.asr_api_key) return { ok: false, message: '未填写 API Key' }
  try {
    let res: Response
    if (settings.asr_provider === 'deepgram') {
      const base = (settings.asr_base_url || 'https://api.deepgram.com').replace(/\/+$/, '')
      res = await fetchWithTimeout(`${base}/v1/projects`, {
        headers: { Authorization: `Token ${settings.asr_api_key}` },
      })
      if (res.ok) return { ok: true, message: '连接成功（项目列表可读）' }
      const body = await res.json().catch(() => null) as { category?: string } | null
      if (body?.category === 'UNAUTHORIZED') return { ok: false, message: '鉴权失败：API Key 无效' }
      return { ok: false, message: `HTTP ${res.status}` }
    }
    if (settings.asr_provider === 'openai-whisper') {
      res = await fetchWithTimeout(joinUrl(settings.asr_base_url, '/models'), {
        headers: { Authorization: `Bearer ${settings.asr_api_key}` },
      })
      if (res.ok) return { ok: true, message: `连接成功（HTTP ${res.status}）` }
      return { ok: false, message: `HTTP ${res.status}：${(await res.text()).slice(0, 140)}` }
    }
    // minimax：空 body POST — 401+1004 鉴权错=无效 key；其他 4xx=已过鉴权、参数校验中
    const base = (settings.asr_base_url || 'https://api.minimaxi.com').replace(/\/+$/, '')
    res = await fetchWithTimeout(joinUrl(base, '/v1/speech_to_text'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.asr_api_key}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    if (res.ok) return { ok: true, message: `连接成功（HTTP ${res.status}）` }
    const body = await res.text()
    const unauthorized = res.status === 401 || body.includes('1004') || body.includes('authorized_error')
    return unauthorized
      ? { ok: false, message: '鉴权失败：API Key 无效' }
      : { ok: true, message: 'Key 有效（已通过鉴权，进入参数校验）' }
  } catch (e) {
    return { ok: false, message: e instanceof Error && e.name === 'AbortError' ? '连接超时' : `网络错误：${String(e)}` }
  }
}