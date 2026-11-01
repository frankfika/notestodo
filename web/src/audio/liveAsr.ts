import { getSettings } from '../db/settings'
import { isTauri } from '../lib/tauri'
import { isReady, catalogById } from '../lib/builtinModels'
import { resolveASRConfig, type TranscriptSegment } from '../types'
import { transcribePcm16k } from '../transcribe/builtin'

/**
 * 本地实时字幕：录音流 → PCM → 每 5 秒切一段喂本机 whisper → 逐段出字。
 *
 * 浏览器 SpeechRecognition 会把音频发到云端，本地模式不能用；桌面版自带 whisper，
 * 所以本地实时字幕走这条路：音频全程不出本机。
 * ponytail: 5 秒一段是权衡（更短会切碎词，更长会等太久），够用即可。
 */

export interface LiveAsrSegment {
  start_ms: number
  end_ms: number
  speaker_label: string
  text: string
}

const SLICE_SECONDS = 5
const TARGET_RATE = 16_000

/** 本地实时字幕是否可用：桌面版 + 内置转录模型已下载 */
export async function localAsrAvailable(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    const s = await getSettings()
    if (s.asr_mode !== 'builtin') return false
    return isReady(resolveASRConfig(s).model)
  } catch {
    return false
  }
}

export function startLocalLiveAsr(
  stream: MediaStream,
  opts: {
    /** 会话开始时间戳（ms），用于换算字幕时间轴 */
    startedAtMs: number
    onSegment: (seg: LiveAsrSegment) => void
    onError: (msg: string) => void
    onFirstResult?: () => void
  },
): () => void {
  let stopped = false
  let ctx: AudioContext
  try {
    ctx = new AudioContext({ sampleRate: TARGET_RATE })
  } catch {
    ctx = new AudioContext()
  }
  void ctx.resume().catch(() => undefined)

  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  // 零增益汇点：ScriptProcessor 必须连到 destination 才会被调度，
  // 接零增益避免把麦克风声音回放到扬声器。
  const sink = ctx.createGain()
  sink.gain.value = 0
  source.connect(processor)
  processor.connect(sink)
  sink.connect(ctx.destination)

  let pending: Float32Array[] = []
  let pendingLen = 0
  let busy = false

  const flush = async (): Promise<void> => {
    if (busy || pendingLen === 0 || stopped) return
    busy = true
    const merged = new Float32Array(pendingLen)
    let off = 0
    for (const chunk of pending) { merged.set(chunk, off); off += chunk.length }
    pending = []
    pendingLen = 0
    try {
      const pcm = ctx.sampleRate === TARGET_RATE ? merged : resample(merged, ctx.sampleRate, TARGET_RATE)
      const settings = await getSettings()
      const hotwords = settings.hotwords ? settings.hotwords.split(/[,\n、，]/).map((s) => s.trim()).filter(Boolean) : []
      const segs = await transcribePcm16k(pcm, settings, hotwords)
      if (stopped) return
      opts.onFirstResult?.()
      const endMs = Date.now() - opts.startedAtMs
      const startMs = Math.max(0, endMs - SLICE_SECONDS * 1000)
      for (const seg of segs) {
        const text = seg.text.trim()
        if (!text) continue
        opts.onSegment({
          start_ms: startMs + (seg.start_ms ?? 0),
          end_ms: startMs + (seg.end_ms ?? SLICE_SECONDS * 1000),
          speaker_label: seg.speaker_label ?? '字幕',
          text,
        })
      }
    } catch (e) {
      opts.onError(e instanceof Error ? e.message : String(e))
    } finally {
      busy = false
    }
  }

  processor.onaudioprocess = (ev) => {
    if (stopped) return
    const input = ev.inputBuffer.getChannelData(0)
    const chunk = new Float32Array(input)
    pending.push(chunk)
    pendingLen += chunk.length
    if (pendingLen >= TARGET_RATE * SLICE_SECONDS) void flush()
  }

  return () => {
    stopped = true
    try { processor.disconnect(); source.disconnect(); sink.disconnect() } catch { /* ignore */ }
    void ctx.close().catch(() => undefined)
  }
}

/** 线性重采样（够用于语音） */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const ratio = from / to
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(input.length - 1, i0 + 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/** 段级时间戳相对切片起点，换算成会议时间轴 */
export function toTranscriptSegments(segs: LiveAsrSegment[]): TranscriptSegment[] {
  return segs.map((s) => ({
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    speaker_label: s.speaker_label,
    text: s.text,
  }))
}

export const builtinModelName = (id: string): string => catalogById(id)?.name ?? id
