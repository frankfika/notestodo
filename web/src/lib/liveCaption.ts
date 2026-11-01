import { create } from 'zustand'
import { db } from '../db/db'
import { getSettings } from '../db/settings'
import type { TranscriptSegment } from '../types'
import { localAsrAvailable, startLocalLiveAsr } from '../audio/liveAsr'

/**
 * 会中实时字幕：浏览器自带 SpeechRecognition（Chrome / Safari / Edge）。
 * - 免费、无需 Key，边说边出字，填满会中「实时转录」栏。
 * - 隐私：Chrome/Edge（及部分 Safari）会把音频发给厂商云端识别 → 默认关闭，用户在会中页一键开启并记住偏好。
 * - 合规：转录选了「本地 / 内置」= 用户要求音频不出本机 → 一律禁用（blocked），偏好也不生效。
 * - 字幕逐句落 kv（live_caption_<meetingId>），散会后 ASR 没配 / 失败时作为兜底转录。
 * ponytail: 无说话人分离、精度不如正式 ASR；正式转录仍以 BYOK / 本地 ASR 为准。
 */

type SR = {
  lang: string; continuous: boolean; interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}

const SRCtor = (): (new () => SR) | undefined => {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export const PREF_KEY = 'live_caption_enabled'
export const captionKey = (meetingId: string): string => `live_caption_${meetingId}`

interface CaptionStore {
  /** blocked = 本地转录模式下禁止走云端字幕 */
  status: 'off' | 'on' | 'unsupported' | 'error' | 'blocked'
  error: string | null
  segments: TranscriptSegment[]
  interim: string
}

export const useCaption = create<CaptionStore>(() => ({ status: 'off', error: null, segments: [], interim: '' }))

export const captionSupported = (): boolean => Boolean(SRCtor())

let current: { rec: SR; meetingId: string; startedAtMs: number; segStart: number | null } | null = null
/** 代际计数：start 体内的 await 窗口里若有人调 stop/重新 start，旧 start 不得继续创建识别器 */
let startGen = 0
/** 本地实时字幕（桌面版 whisper）的停止句柄 */
let localStop: (() => void) | null = null
/** 录音引擎提供当前采集流（混音后），供会中页一键开启本地字幕 */
let streamProvider: (() => MediaStream | null) | null = null
export function registerCaptionStreamProvider(fn: () => MediaStream | null): void {
  streamProvider = fn
}

export async function startLiveCaption(meetingId: string, startedAtMs: number, stream?: MediaStream): Promise<void> {
  stopLiveCaption()
  const gen = startGen
  const Ctor = SRCtor()
  const settings = await getSettings()
  // await 窗口内用户可能已点停止 —— 别在「已停止」之后继续创建识别器
  if (gen !== startGen) return

  // 本地 / 内置转录：音频不出本机 → 走本机 whisper 增量出字（桌面版），浏览器无本地模型则禁用
  if (settings.asr_mode !== 'cloud') {
    const pref = await db.kv.get(PREF_KEY)
    if (gen !== startGen) return
    if (pref?.value === false) { useCaption.setState({ status: 'off', segments: [], interim: '' }); return }
    if (stream && await localAsrAvailable()) {
      if (gen !== startGen) return
      useCaption.setState({ segments: [], interim: '', error: null, status: 'on' })
      localStop = startLocalLiveAsr(stream, {
        startedAtMs,
        onSegment: (seg) => {
          const segments = [...useCaption.getState().segments, seg]
          useCaption.setState({ segments })
          void db.kv.put({ key: captionKey(meetingId), value: segments })
        },
        onError: (msg) => useCaption.setState({ status: 'error', error: `本地实时字幕出错：${msg}` }),
      })
      return
    }
    useCaption.setState({ status: 'blocked', segments: [], interim: '' })
    return
  }
  if (!Ctor) { useCaption.setState({ status: 'unsupported', segments: [], interim: '' }); return }
  const pref = await db.kv.get(PREF_KEY)
  if (gen !== startGen) return
  useCaption.setState({ segments: [], interim: '', error: null, status: 'off' })
  if (pref?.value !== true) return

  const rec = new Ctor()
  // 中文产品默认普通话；英文系统界面用英文
  rec.lang = navigator.language.startsWith('en') ? 'en-US' : 'zh-CN'
  rec.continuous = true
  rec.interimResults = true
  const me = { rec, meetingId, startedAtMs, segStart: null as number | null }
  current = me

  rec.onresult = (e) => {
    if (current !== me) return
    const t = Date.now() - startedAtMs
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      const text = r[0]?.transcript.trim() ?? ''
      if (!text) continue
      me.segStart ??= t
      if (r.isFinal) {
        const seg: TranscriptSegment = { start_ms: me.segStart, end_ms: t, speaker_label: '字幕', text }
        me.segStart = null
        const segments = [...useCaption.getState().segments, seg]
        useCaption.setState({ segments })
        void db.kv.put({ key: captionKey(meetingId), value: segments })
      } else {
        interim += text
      }
    }
    useCaption.setState({ interim })
  }
  rec.onerror = (e) => {
    if (current !== me) return
    // no-speech / aborted 是常态，自动续上；权限 / 网络类错误才停
    if (e.error === 'no-speech' || e.error === 'aborted') return
    // service-not-allowed：识别服务不可用（桌面版 WKWebView / 无网络）→ 走 unsupported 友好态，不报错
    if (e.error === 'service-not-allowed' || e.error === 'language-not-supported') {
      useCaption.setState({ status: 'unsupported' })
      current = null
      return
    }
    useCaption.setState({ status: 'error', error: e.error === 'not-allowed' ? '浏览器拒绝了语音识别权限' : `语音识别出错：${e.error}` })
    current = null
  }
  // Chrome 静音一段时间会自己结束 → 录音没停就续上
  rec.onend = () => { if (current === me) { try { rec.start() } catch { /* 已在运行 */ } } }

  try {
    rec.start()
    useCaption.setState({ status: 'on' })
  } catch (e) {
    current = null
    useCaption.setState({ status: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}

export function stopLiveCaption(): void {
  startGen++
  const me = current
  current = null
  if (me) { try { me.rec.stop() } catch { /* ignore */ } }
  if (localStop) { try { localStop() } catch { /* ignore */ } localStop = null }
  useCaption.setState((s) => ({ status: s.status === 'on' ? 'off' : s.status, interim: '' }))
}

/** 会中一键开 / 关；偏好写 kv，下场会议沿用 */
export async function setLiveCaptionEnabled(on: boolean, meetingId: string, startedAtMs: number): Promise<void> {
  await db.kv.put({ key: PREF_KEY, value: on })
  if (on) await startLiveCaption(meetingId, startedAtMs, streamProvider?.() ?? undefined)
  else { stopLiveCaption(); useCaption.setState({ status: 'off' }) }
}

/** 散会后读出字幕（兜底转录用） */
export async function loadCaptions(meetingId: string): Promise<TranscriptSegment[]> {
  const row = await db.kv.get(captionKey(meetingId))
  return Array.isArray(row?.value) ? (row.value as TranscriptSegment[]) : []
}
