import type { TranscriptSegment } from '../types'
import type { AsrProvider } from './types'

/**
 * OpenAI Whisper (and compatible: Groq, Together, Fireworks, vLLM, …)
 * adapter.
 *
 * Endpoint: POST {base_url}/audio/transcriptions
 * Body: multipart/form-data with `file`, `model`, `response_format=verbose_json`,
 *       `timestamp_granularities[]=segment`, optional `language`.
 *
 * No built-in speaker diarization — every segment is tagged "说话人 1".
 * The UI can show/hide the speaker column; the data is still consistent.
 *
 * Reference: OpenAI Audio API docs.
 */
export const openaiWhisperProvider: AsrProvider = {
  id: 'openai-whisper',
  transcribe: async ({ blob, settings, language }) => {
    if (!settings.asr_api_key) {
      throw new Error('Whisper API key is empty — set it in Settings.')
    }
    if (!settings.asr_base_url) {
      throw new Error('Whisper base URL is empty — set it in Settings.')
    }
    const url = joinUrl(settings.asr_base_url, '/audio/transcriptions')

    const form = new FormData()
    form.append('file', blob, fileNameFor(blob))
    form.append('model', settings.asr_model || 'whisper-large-v3-turbo')
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'segment')
    if (language) form.append('language', language)

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.asr_api_key}` },
      body: form,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `Whisper transcription failed (${res.status} ${res.statusText}): ${truncate(text)}`,
      )
    }
    const json = parseJson(text) as WhisperVerboseResponse
    return normaliseSegments(json)
  },
}

// ── response shapes ───────────────────────────────────────────────────────────

interface WhisperSegmentRaw {
  id?: number
  start?: number
  end?: number
  text?: string
}
interface WhisperVerboseResponse {
  task?: string
  language?: string
  duration?: number
  text?: string
  segments?: WhisperSegmentRaw[]
  words?: unknown[] // we don't use word-level here, but tolerate the shape
}

function normaliseSegments(raw: WhisperVerboseResponse): TranscriptSegment[] {
  const segs = Array.isArray(raw.segments) ? raw.segments : []
  if (segs.length === 0) {
    // Defensive fallback: some compatible servers omit `segments` but still
    // give us full text + duration. Emit a single segment so downstream code
    // doesn't have to special-case empty transcripts.
    const fullText = (raw.text ?? '').trim()
    if (!fullText) return []
    return [
      {
        start_ms: 0,
        end_ms: Math.round((raw.duration ?? 0) * 1000),
        speaker_label: '说话人 1',
        text: fullText,
      },
    ]
  }
  const out: TranscriptSegment[] = []
  for (const seg of segs) {
    const text = (seg.text ?? '').trim()
    if (!text) continue
    const startSec = typeof seg.start === 'number' ? seg.start : 0
    const endSec = typeof seg.end === 'number' ? seg.end : startSec
    const startMs = Math.max(0, Math.round(startSec * 1000))
    const endMs = Math.max(startMs, Math.round(endSec * 1000))
    out.push({
      start_ms: startMs,
      end_ms: endMs,
      speaker_label: '说话人 1',
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
    throw new Error(`Whisper returned non-JSON body: ${truncate(text)}`)
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
