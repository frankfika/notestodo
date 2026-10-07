import type { AppSettings, TranscriptSegment } from '../types'
import type { AsrProvider } from './types'

/**
 * MiniMax ASR adapter (model: asr-1.0).
 *
 * Reference: https://api.minimax.io/v1/speech_to_text
 *
 * Quirks:
 *  - Hard limit: ≤ 500 s per request and ≤ 50 MB. Anything longer gets 400.
 *  - Verbose JSON returns { text, duration, n_speakers, segments: [{id, start, end, speaker, text}] }
 *    where `speaker` is local-per-chunk ("S1", "S2", …).
 *  - For MVP we send the WHOLE merged blob if it's within the limit; if the
 *    meeting exceeds 480 s (≈8 min) we refuse with a clear error message so
 *    the user can switch to Deepgram / openai-whisper (which handle longer
 *    audio natively). Cross-chunk speaker merging is therefore not exercised
 *    in v1 — documented as a known limitation in the shared spec.
 */
export const minimaxProvider: AsrProvider = {
  id: 'minimax',
  transcribe: async ({ blob, durationMs, settings, language }) => {
    if (!settings.asr_api_key) {
      throw new Error('MiniMax ASR API key is empty — set it in Settings.')
    }
    if (!settings.asr_base_url) {
      throw new Error('MiniMax ASR base URL is empty — set it in Settings.')
    }
    const MAX_MS = 480 * 1000 // leave 20s buffer below the 500s hard limit
    if (durationMs > MAX_MS) {
      const minutes = Math.ceil(durationMs / 60000)
      throw new Error(
        `MiniMax ASR 上限为单次 8 分钟（实测 ${minutes} 分钟）。` +
          '请在 Settings 把语音供应商切换为 Deepgram 或 openai-whisper，或缩短会议。',
      )
    }

    const url = joinUrl(settings.asr_base_url, '/v1/speech_to_text')
    const form = new FormData()
    form.append('model', settings.asr_model || 'asr-1.0')
    form.append('file', blob, fileNameFor(blob))
    form.append('response_format', 'verbose_json')
    form.append('timestamp_level', 'word')
    if (language) form.append('language', language)

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.asr_api_key}` },
      body: form,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `MiniMax ASR failed (${res.status} ${res.statusText}): ${truncate(text)}`,
      )
    }
    const json = parseJson(text) as MiniMaxVerboseResponse
    return normaliseSegments(json)
  },
}

// ── response shapes ───────────────────────────────────────────────────────────

interface MiniMaxSegmentRaw {
  id?: number
  start?: number
  end?: number
  speaker?: string
  text?: string
}
interface MiniMaxVerboseResponse {
  text?: string
  duration?: number
  n_speakers?: number
  segments?: MiniMaxSegmentRaw[]
  trace_id?: string
}

function normaliseSegments(raw: MiniMaxVerboseResponse): TranscriptSegment[] {
  const segs = Array.isArray(raw.segments) ? raw.segments : []
  if (segs.length === 0) return []

  // Build a global remap table: local speaker labels → sequential 说话人 N.
  // MiniMax returns labels like "S1", "S2"; we normalise anything that looks
  // like S<n> (or "说话人 n") to a deterministic global index, then format
  // back into the "说话人 N" label our UI expects.
  const localToGlobal = new Map<string, number>()
  for (const seg of segs) {
    const local = (seg.speaker ?? '').trim() || 'S?'
    if (!localToGlobal.has(local)) {
      localToGlobal.set(local, localToGlobal.size + 1)
    }
  }

  const out: TranscriptSegment[] = []
  for (const seg of segs) {
    const text = (seg.text ?? '').trim()
    if (!text) continue
    const startSec = typeof seg.start === 'number' ? seg.start : 0
    const endSec = typeof seg.end === 'number' ? seg.end : startSec
    const startMs = Math.max(0, Math.round(startSec * 1000))
    const endMs = Math.max(startMs, Math.round(endSec * 1000))
    const local = (seg.speaker ?? '').trim() || 'S?'
    const idx = localToGlobal.get(local) ?? 1
    out.push({
      start_ms: startMs,
      end_ms: endMs,
      speaker_label: `说话人 ${idx}`,
      text,
    })
  }
  return out
}

// ── helpers ───────────────────────────────────────────────────────────────────

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

function truncate(s: string, max = 400): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`MiniMax ASR returned non-JSON body: ${truncate(text)}`)
  }
}

function fileNameFor(blob: Blob): string {
  const t = (blob.type || '').toLowerCase()
  if (t.includes('webm')) return 'audio.webm'
  if (t.includes('mp4')) return 'audio.m4a'
  if (t.includes('ogg')) return 'audio.ogg'
  if (t.includes('wav')) return 'audio.wav'
  if (t.includes('mpeg')) return 'audio.mp3'
  return 'audio.bin'
}
