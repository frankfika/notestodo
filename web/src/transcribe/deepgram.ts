import type { TranscriptSegment } from '../types'
import type { AsrProvider } from './types'

/**
 * Deepgram Nova-3 adapter with native speaker diarization.
 *
 * Endpoint: POST https://api.deepgram.com/v1/listen
 * Query:    model=nova-3&language=zh&diarize=true&punctuate=true&smart_format=true
 * Headers:  Authorization: Token <KEY>, Content-Type: <audio mime>
 * Body:     raw audio bytes.
 *
 * Response walk: results.channels[0].alternatives[0].paragraphs.paragraphs[*]
 * Each paragraph has a `speaker` (integer) and `sentences[]`; each sentence
 * has `text`, `start`, `end` (seconds) and optionally its own `speaker`.
 *
 * The actual Deepgram response is shape-flexible (nova-3 may surface
 * `utterances[]` instead of `paragraphs.paragraphs[].sentences[]` when
 * asked), so this adapter is intentionally permissive — it falls back to
 * `utterances[]` when paragraphs are absent, and to words[] with `speaker`
 * fields as a last resort. The README documents this as the safest
 * behaviour given Deepgram's evolving schema.
 */
export const deepgramProvider: AsrProvider = {
  id: 'deepgram',
  transcribe: async ({ blob, mimeType, settings }) => {
    if (!settings.asr_api_key) {
      throw new Error('Deepgram API key is empty — set it in Settings.')
    }
    const base = (settings.asr_base_url || 'https://api.deepgram.com').replace(
      /\/+$/,
      '',
    )
    const url =
      `${base}/v1/listen?model=nova-3&language=zh` +
      `&diarize=true&punctuate=true&smart_format=true`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${settings.asr_api_key}`,
        'Content-Type': mimeType || 'application/octet-stream',
      },
      body: blob,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `Deepgram transcription failed (${res.status} ${res.statusText}): ${truncate(text)}`,
      )
    }
    const json = parseJson(text) as DeepgramResponse
    return normaliseSegments(json)
  },
}

// ── response shapes ───────────────────────────────────────────────────────────

interface DeepgramWord {
  word?: string
  punctuated_word?: string
  start?: number
  end?: number
  speaker?: number
}
interface DeepgramSentence {
  text?: string
  start?: number
  end?: number
  speaker?: number
}
interface DeepgramParagraph {
  speaker?: number
  sentences?: DeepgramSentence[]
  start?: number
  end?: number
}
interface DeepgramParagraphs {
  transcript?: string
  paragraphs?: DeepgramParagraph[]
}
interface DeepgramUtterance {
  start?: number
  end?: number
  speaker?: number
  transcript?: string
}
interface DeepgramAlternative {
  transcript?: string
  words?: DeepgramWord[]
  paragraphs?: DeepgramParagraphs
}
interface DeepgramChannel {
  alternatives?: DeepgramAlternative[]
}
interface DeepgramResults {
  channels?: DeepgramChannel[]
  utterances?: DeepgramUtterance[]
}
interface DeepgramResponse {
  results?: DeepgramResults
}

function normaliseSegments(raw: DeepgramResponse): TranscriptSegment[] {
  const alt = raw.results?.channels?.[0]?.alternatives?.[0]
  if (!alt) return []

  // Speaker label is a stable integer from Deepgram; we re-number them
  // 1..N in order of first appearance so the UI shows 说话人 1, 说话人 2, …
  const speakerMap = new Map<number, number>()
  const nextSpeaker = (s: number | undefined): number => {
    if (typeof s !== 'number') return 1
    let idx = speakerMap.get(s)
    if (idx === undefined) {
      idx = speakerMap.size + 1
      speakerMap.set(s, idx)
    }
    return idx
  }
  const label = (s: number | undefined): string =>
    `说话人 ${nextSpeaker(s)}`

  const segs: TranscriptSegment[] = []

  // 1) Preferred path: paragraphs.paragraphs[].sentences[]
  const paragraphs = alt.paragraphs?.paragraphs
  if (Array.isArray(paragraphs) && paragraphs.length > 0) {
    for (const para of paragraphs) {
      const sentences = Array.isArray(para.sentences) ? para.sentences : []
      const fallbackSpeaker = para.speaker
      for (const sent of sentences) {
        const text = (sent.text ?? '').trim()
        if (!text) continue
        const startMs = msFromSec(sent.start, fallbackSpeaker, para.start)
        const endMs = msFromSec(sent.end, fallbackSpeaker, para.end, startMs)
        segs.push({
          start_ms: startMs,
          end_ms: endMs,
          speaker_label: label(
            typeof sent.speaker === 'number' ? sent.speaker : fallbackSpeaker,
          ),
          text,
        })
      }
    }
    if (segs.length > 0) return segs
  }

  // 2) Fallback: utterances[]
  const utterances = raw.results?.utterances
  if (Array.isArray(utterances) && utterances.length > 0) {
    for (const utt of utterances) {
      const text = (utt.transcript ?? '').trim()
      if (!text) continue
      const startMs = msFromSec(utt.start)
      const endMs = msFromSec(utt.end, undefined, undefined, startMs)
      segs.push({
        start_ms: startMs,
        end_ms: endMs,
        speaker_label: label(utt.speaker),
        text,
      })
    }
    if (segs.length > 0) return segs
  }

  // 3) Last resort: words[] — group consecutive words by speaker into segments
  const words = Array.isArray(alt.words) ? alt.words : []
  if (words.length > 0) {
    let cur: DeepgramWord[] = []
    let curSpeaker: number | undefined
    const flush = () => {
      if (cur.length === 0) return
      const text = cur
        .map((w) => (w.punctuated_word ?? w.word ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .trim()
      if (!text) {
        cur = []
        return
      }
      const first = cur[0] as DeepgramWord
      const last = cur[cur.length - 1] as DeepgramWord
      segs.push({
        start_ms: msFromSec(first.start),
        end_ms: msFromSec(last.end, undefined, undefined, msFromSec(first.start)),
        speaker_label: label(curSpeaker),
        text,
      })
      cur = []
      curSpeaker = undefined
    }
    for (const w of words) {
      if (curSpeaker !== w.speaker && cur.length > 0) flush()
      curSpeaker = w.speaker
      cur.push(w)
    }
    flush()
  }

  // 4) Absolute last resort: just emit the full transcript as one segment.
  if (segs.length === 0 && alt.transcript) {
    const text = alt.transcript.trim()
    if (text) {
      segs.push({
        start_ms: 0,
        end_ms: 0,
        speaker_label: '说话人 1',
        text,
      })
    }
  }

  return segs
}

// ── helpers ───────────────────────────────────────────────────────────────────

function msFromSec(
  sec: number | undefined,
  _ignoredSpeaker?: number,
  fallback?: number,
  min?: number,
): number {
  let v: number
  if (typeof sec === 'number' && Number.isFinite(sec)) v = sec
  else if (typeof fallback === 'number' && Number.isFinite(fallback)) v = fallback
  else v = 0
  const ms = Math.max(0, Math.round(v * 1000))
  return typeof min === 'number' ? Math.max(min, ms) : ms
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Deepgram returned non-JSON body: ${truncate(text)}`)
  }
}

function truncate(s: string, max = 400): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}
