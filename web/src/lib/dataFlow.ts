import { resolveASRConfig, resolveLLMConfig, type AppSettings } from '../types'

/**
 * 数据去向（合规自检）：会议内容（录音 / 转录 / 速记）会被发到哪里。
 * 「本地」只认回环地址 —— 填了局域网 / 公网地址的「Local」不算本机，如实标出来。
 */
export type Where = 'device' | 'remote'

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
  } catch {
    return false
  }
}

const hostOf = (url: string): string => {
  try { return new URL(url).host } catch { return url || '（未填）' }
}

export interface FlowItem { what: string; where: Where; to: string }

export function dataFlow(s: AppSettings, captionsOn: boolean): FlowItem[] {
  const asr = resolveASRConfig(s)
  const llm = resolveLLMConfig(s)
  const item = (what: string, url: string, local: boolean, builtin: boolean): FlowItem => {
    if (builtin) return { what, where: 'device', to: '本机（应用内置模型）' }
    const onDevice = local && isLoopbackUrl(url)
    return { what, where: onDevice ? 'device' : 'remote', to: onDevice ? '本机' : hostOf(url) }
  }
  const out = [
    item('录音 → 转录', asr.base_url, asr.is_local, asr.provider === 'builtin'),
    item('转录 + 速记 → 笔记 / 待办 / 对话', llm.base_url, llm.is_local, llm.provider === 'builtin'),
  ]
  // 浏览器字幕：本地转录模式下被禁用（见 lib/liveCaption）
  if (captionsOn && s.asr_mode === 'cloud') out.push({ what: '会中实时字幕', where: 'remote', to: '浏览器厂商云端' })
  return out
}
