import type { Meeting, Transcript, TranscriptSegment } from '../types'

/**
 * Default system prompt for meeting summarisation.
 * Instructs the model to return only a strict JSON object — no prose,
 * no markdown fences. The expected shape:
 *   { summary_md: string,
 *     todos: Array<{title, assignee_hint?, due_hint?, evidence_quote?, evidence_span?: [number, number]}>,
 *     decisions?: string[] }
 * Evidence quotes and [start_ms, end_ms] MUST come from the transcript
 * verbatim; fabrication is forbidden.
 */
export const DEFAULT_SUMMARY_SYSTEM =
  '你是一位专业的会议纪要秘书。仅基于提供的会议转录输出合法 JSON，' +
  '结构严格匹配 {summary_md: string, ' +
  'todos: Array<{title, assignee_hint?, due_hint?, evidence_quote?, evidence_span?: [number, number]>},' +
  ' decisions?: string[]}。证据引文与 [start_ms, end_ms] 来自转录原文，禁止编造。' +
  '若转录中未提到截止日期或负责人，相关字段填空字符串或省略。' +
  'evidence_span 单位为毫秒，end_ms 必须大于 start_ms。'

/**
 * Render a template's `prompt_md` by substituting `{{path.to.value}}`
 * tokens against the given `vars` object.
 *
 * - Lookup is dotted-path (`meeting.title`, `transcript.full`, ...).
 * - Non-existent paths become the empty string (so a missing `{{user.foo}}`
 *   doesn't blow up — it just renders as `""`).
 * - String values are inserted as-is; everything else is JSON-serialised
 *   so lists/objects don't render as `[object Object]`.
 *
 * Note: this is a string-substitution renderer, NOT a sandboxed template
 * engine. The transcript text is interpolated verbatim — wrap it in
 * explicit delimiters in your prompt (e.g. `<transcript>…</transcript>`)
 * and rely on the system prompt to tell the model the contents are data.
 */
export function renderTemplate(
  promptMd: string,
  vars: Record<string, unknown>,
): string {
  return promptMd.replace(
    /\{\{(\w+(?:\.\w+)*)\}\}/g,
    (_match, path: string) => {
      const value = getNested(vars, path)
      if (value === undefined || value === null) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value)
      }
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    },
  )
}

function getNested(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/**
 * Build the default variable bag for `renderTemplate`.
 * Covers the variables referenced by the built-in templates:
 *   - {{meeting.title}}   {{meeting.date}}    {{meeting.duration}}
 *   - {{transcript.full}} {{transcript.speakers}}
 *
 * `transcript.full` is a speaker-tagged plain-text rendering, e.g.
 *   [00:00–00:14] 说话人 1: 大家好，今天我们讨论一下……
 */
export function defaultVars(
  meeting: Meeting,
  transcript: Transcript,
): Record<string, unknown> {
  const speakers = uniqueSpeakers(transcript.segments)
  return {
    meeting: {
      title: meeting.title || '未命名会议',
      date: fmtMeetingDate(meeting.started_at),
      duration: fmtDuration(meeting.audio.duration_ms),
    },
    transcript: {
      // 长转录成本保护：超过 16K 字符截断并附标记（summarize 容忍度高，留多一点）
      full: truncateLong(segmentsToText(transcript.segments), 16_000, transcript.segments.length),
      speakers: speakers.join('、'),
    },
  }
}

/** 长转录截断：保留前 N 字符 + 标记省略了后续 M 段（segments 总数）。 */
function truncateLong(text: string, limit: number, totalSegments: number): string {
  if (text.length <= limit) return text
  const dropped = text.length - limit
  return `${text.slice(0, limit)}\n\n[…以下 ${dropped} 字符被省略，原转录共 ${totalSegments} 段。]`
}

/** Unique speaker labels in first-appearance order. */
function uniqueSpeakers(segments: TranscriptSegment[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const seg of segments) {
    if (seg.speaker_label && !seen.has(seg.speaker_label)) {
      seen.add(seg.speaker_label)
      out.push(seg.speaker_label)
    }
  }
  return out
}

/** Format meeting date as YYYY-MM-DD HH:mm in local time. */
function fmtMeetingDate(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Human-readable duration like "1h 23m" or "12m 05s". */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** Render segments as a tagged transcript: [hh:mm:ss–hh:mm:ss] speaker: text */
function segmentsToText(segments: TranscriptSegment[]): string {
  if (!segments || segments.length === 0) return ''
  const fmtTs = (ms: number): string => {
    const totalSec = Math.floor(ms / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(h)}:${p(m)}:${p(s)}`
  }
  const out: string[] = []
  for (const seg of segments) {
    const start = fmtTs(seg.start_ms)
    const end = fmtTs(seg.end_ms)
    const label = seg.speaker_label || '说话人 ?'
    const text = (seg.text || '').trim()
    if (!text) continue
    out.push(`[${start}–${end}] ${label}: ${text}`)
  }
  return out.join('\n')
}
