import { db } from '../db/db'
import { getSettings } from '../db/settings'
import { callLLM, type ChatMessage } from '../llm/client'
import {
  DEFAULT_SUMMARY_SYSTEM,
  defaultVars,
  parseTimeHint,
  renderTemplate,
  scribbleBlock,
  scribblesToMarkdown,
  stripFence,
} from '../llm/prompts'
import { now } from '../lib/id'
import { oncePerMeeting } from './once'
import type {
  AppSettings,
  Meeting,
  Summary,
  SummaryTemplate,
  Todo,
  Transcript,
} from '../types'

/**
 * Summarisation pipeline.
 *
 * Flow:
 *   1. meeting.status = 'summarizing'
 *   2. Load meeting + transcript + template (default or per-meeting override)
 *   3. Render template with {{meeting.*}} / {{transcript.*}} variables
 *   4. Single LLM call with jsonMode=true; expect
 *      { summary_md, todos: [{title, assignee_hint?, due_hint?, evidence_quote?, evidence_span?: [start_ms, end_ms]}], decisions? }
 *   5. Persist Summary; create a Todo row per actionable item
 *   6. meeting.status = 'summarized'
 *
 * Retry policy: on parse / network failure, retry once with a larger
 * max_tokens budget; on the second failure mark 'failed' with the error.
 */
export const runSummarizePipeline = oncePerMeeting(async (meetingId: string): Promise<void> => {
  const meeting = await db.meetings.get(meetingId)
  if (!meeting) throw new Error(`Meeting ${meetingId} not found`)

  const transcript = await db.transcripts
    .where('meeting_id')
    .equals(meetingId)
    .first()
  if (!transcript) {
    await db.meetings.update(meetingId, {
      status: 'failed',
      error: '转录不存在，无法生成纪要',
      updated_at: now(),
    })
    return
  }

  const scribbleMd = scribblesToMarkdown(
    await db.scribbles.where('meeting_id').equals(meetingId).sortBy('created_at'),
  )
  if (transcript.segments.length === 0 && !scribbleMd.trim()) {
    await db.meetings.update(meetingId, {
      status: 'failed',
      error: '没有识别到语音（音频太短或麦克风静音），也没有速记可整理',
      updated_at: now(),
    })
    return
  }

  // If a summary already exists, just mark and exit.
  const existing = await db.summaries
    .where('meeting_id')
    .equals(meetingId)
    .first()
  if (existing) {
    await db.meetings.update(meetingId, {
      status: 'summarized',
      updated_at: now(),
    })
    return
  }

  await db.meetings.update(meetingId, {
    status: 'summarizing',
    error: undefined,
    updated_at: now(),
  })

  const template = await resolveTemplate(meetingId)
  const settings = await getSettings()
  const vars = defaultVars(meeting, transcript)
  const userPrompt = renderTemplate(template.prompt_md, vars) + scribbleBlock(scribbleMd)

  const messages: ChatMessage[] = [
    { role: 'system', content: DEFAULT_SUMMARY_SYSTEM },
    { role: 'user', content: userPrompt },
  ]

  const parsed = await callLlmWithRetry(meetingId, settings, messages, {
    maxTokens: 4096,
    temperature: 0.2,
  })

  if (!parsed) {
    // Second attempt also failed; status was already updated to 'failed'
    // inside callLlmWithRetry.
    return
  }

  // Append decisions list to summary_md if present, so the markdown view
  // also surfaces them without forcing the user to dig into raw JSON.
  // Then scrub any stray "[]" / "{}" lines the model emitted for empty
  // sections — those should read "无" instead (system prompt insists on it).
  const summaryMd = tidyEmptySections(
    composeSummaryMarkdown(parsed.summaryMd, parsed.decisions),
  )
  if (!summaryMd) {
    await db.meetings.update(meetingId, { status: 'failed', error: '生成笔记失败：模型返回的笔记为空', updated_at: now() })
    return
  }

  const summary: Summary = {
    id: crypto.randomUUID(),
    meeting_id: meetingId,
    template_id: template.id,
    content_md: summaryMd,
    raw_llm_output: parsed.raw as unknown,
    generated_at: now(),
    model: settings.llm_model,
    created_at: now(),
    updated_at: now(),
    deleted_at: null,
    sync_version: 0,
  }
  await db.summaries.put(summary)

  // 同一份成果也写进会议笔记（Notes 页 / 会议页「笔记」读的都是它）；
  // AI 给的标题只替换默认的「会议 · 日期」占位名，绝不覆盖用户/日历起的名字。
  const aiTitle = parsed.title.trim()
  const title = aiTitle && DEFAULT_TITLE_RE.test(meeting.title) ? aiTitle : meeting.title
  const noteBody = summaryMd
  if (meeting.note_id && (await db.notes.get(meeting.note_id))) {
    await db.notes.update(meeting.note_id, { title, body_md: noteBody, updated_at: now() })
  } else {
    const noteId = crypto.randomUUID()
    await db.notes.put({
      id: noteId, title, body_md: noteBody, meeting_id: meetingId, todo_ids: [], pinned: false,
      created_at: now(), updated_at: now(), deleted_at: null, sync_version: 0,
    })
    await db.meetings.update(meetingId, { note_id: noteId })
  }
  if (title !== meeting.title) await db.meetings.update(meetingId, { title })

  // 重新生成时先清掉上一轮还没确认的待办，避免重复。
  await db.todos
    .where('meeting_id').equals(meetingId)
    .and((t) => t.status === 'pending_review')
    .delete()

  // Persist each todo. 定位不到出处也要保留 —— 丢待办比缺出处糟糕得多。
  let sortOrder = 0
  for (const t of parsed.todos) {
    const title = (t.title ?? '').trim()
    if (!title) continue
    const quote = (t.evidence_quote ?? '').trim()
    const span = locateSpan(t, quote, transcript, meeting.audio.duration_ms)
    const todo: Todo = {
      id: crypto.randomUUID(),
      kind: 'task',
      scope: null,
      parent_id: null,
      title,
      notes_md: !span && quote ? `> ${quote}` : '',
      status: 'pending_review',
      due_date: parseLooseDate(t.due_hint),
      assignee: (t.assignee_hint ?? '').trim() || undefined,
      source: 'meeting',
      meeting_id: meetingId,
      transcript_span: span ? { start_ms: span[0], end_ms: span[1], quote } : undefined,
      sort_order: sortOrder++,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
      sync_version: 0,
    }
    await db.todos.put(todo)
  }

  await db.meetings.update(meetingId, {
    status: 'summarized',
    updated_at: now(),
  })
})

/** 录音时自动起的占位标题（「会议 · 2026-10-14 16:32」），AI 标题可以替换它。 */
const DEFAULT_TITLE_RE = /^(会议|新会议|未命名会议)(\s*·\s*\d{4}-\d{2}-\d{2}.*)?$/

/**
 * 把待办落到转录里的某一段。优先级：模型给的时间（"mm:ss" / 毫秒区间）→ 引文在转录里的原句匹配。
 * 都对不上返回 undefined（待办照常保留，只是没有跳转）。
 */
function locateSpan(
  t: RawTodo,
  quote: string,
  transcript: Transcript,
  meetingMs: number,
): [number, number] | undefined {
  const segs = transcript.segments
  if (segs.length === 0) return undefined
  const spanOf = (i: number): [number, number] => [segs[i]!.start_ms, Math.max(segs[i]!.end_ms, segs[i]!.start_ms + 1)]

  if (t.evidence_span) {
    const sp = pickValidSpan(t.evidence_span, meetingMs)
    if (sp) return sp
  }
  const at = parseTimeHint(t.evidence_time)
  if (at !== undefined) {
    let best = 0
    for (let i = 1; i < segs.length; i++) {
      if (Math.abs(segs[i]!.start_ms - at) < Math.abs(segs[best]!.start_ms - at)) best = i
    }
    return spanOf(best)
  }
  const q = quote.replace(/\s+/g, '')
  if (q.length >= 4) {
    const i = segs.findIndex((sg) => sg.text.replace(/\s+/g, '').includes(q.slice(0, 16)))
    if (i >= 0) return spanOf(i)
  }
  return undefined
}

// ── template resolution ───────────────────────────────────────────────────────

async function resolveTemplate(meetingId: string): Promise<SummaryTemplate> {
  // Per-meeting override stored in db.kv: 'meeting_template_<meetingId>'
  const kv = await db.kv.get(`meeting_template_${meetingId}`)
  const overrideId = typeof kv?.value === 'string' ? kv.value : null
  if (overrideId) {
    const t = await db.templates.get(overrideId)
    if (t && !t.deleted_at) return t
  }
  // Dexie doesn't index booleans, so walk the table.
  const all = await db.templates.toArray()
  const fallback =
    all.find((t) => !t.deleted_at && t.is_default) ??
    all.find((t) => !t.deleted_at && t.builtin) ??
    all.find((t) => !t.deleted_at)
  if (fallback) return fallback
  // Absolute last resort — synthesise so we never crash before producing
  // something for the user.
  return {
    id: 'synthetic-default',
    name: '默认模板（兜底）',
    icon: '📋',
    prompt_md:
      '请基于转录生成 Markdown 纪要，包含「一句话结论 / 讨论要点 / 决定 / 行动项」四节。\n\n<transcript>\n{{transcript.full}}\n</transcript>',
    is_default: true,
    builtin: true,
    created_at: now(),
    updated_at: now(),
    deleted_at: null,
    sync_version: 0,
  }
}

// ── LLM call + retry + parse ──────────────────────────────────────────────────

interface LlmAttemptResult {
  raw: unknown
  title: string
  summaryMd: string
  todos: RawTodo[]
  decisions?: string[]
}

interface RawTodo {
  title?: string
  assignee_hint?: string
  due_hint?: string
  evidence_quote?: string
  evidence_span?: [number, number]
  evidence_time?: string | number
}

async function callLlmWithRetry(
  meetingId: string,
  settings: AppSettings,
  messages: ChatMessage[],
  baseOpts: { maxTokens: number; temperature: number },
): Promise<LlmAttemptResult | null> {
  try {
    const raw = await callLLM(settings, messages, {
      jsonMode: true,
      maxTokens: baseOpts.maxTokens,
      temperature: baseOpts.temperature,
    })
    const parsed = parseLooseJson(raw)
    if (!parsed) throw new Error('LLM 输出无法解析为 JSON 对象')
    return normaliseResult(parsed, raw)
  } catch {
    // 首次失败不闪「失败」状态 —— 静默重试一次，两次都失败才报错。
    // Retry once with a larger token budget to give the model room.
    try {
      const raw = await callLLM(settings, messages, {
        jsonMode: true,
        maxTokens: baseOpts.maxTokens * 2,
        temperature: baseOpts.temperature,
      })
      const parsed = parseLooseJson(raw)
      if (!parsed) throw new Error('重试输出仍无法解析为 JSON 对象')
      return normaliseResult(parsed, raw)
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2)
      if (meetingId) {
        await db.meetings.update(meetingId, {
          status: 'failed',
          error: `生成笔记失败：${msg2}`,
          updated_at: now(),
        })
      }
      return null
    }
  }
}

/**
 * Try to recover a meetingId from the messages we sent; used only to keep
 * `meeting.error` accurate. Since we don't bake it into the prompt, we
 * fall back to undefined (best-effort).
 */

// ── JSON parsing ──────────────────────────────────────────────────────────────

function parseLooseJson(raw: string): unknown | null {
  let text = raw.trim()
  // Strip ```json fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fence && fence[1]) text = fence[1].trim()
  try {
    return JSON.parse(text)
  } catch {
    // Try to grab the first {...} block.
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const slice = text.slice(start, end + 1)
      try {
        return JSON.parse(slice)
      } catch {
        return null
      }
    }
    return null
  }
}

function normaliseResult(parsed: unknown, raw: string): LlmAttemptResult {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM 输出不是对象')
  }
  const obj = parsed as Record<string, unknown>
  const summaryMd = stripFence(
    typeof obj.summary_md === 'string' ? obj.summary_md : '',
  )
  const title = typeof obj.title === 'string' ? obj.title : ''
  const decisions = Array.isArray(obj.decisions)
    ? obj.decisions.filter((d): d is string => typeof d === 'string')
    : undefined
  const todosRaw = Array.isArray(obj.todos) ? obj.todos : []
  const todos: RawTodo[] = todosRaw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      title: typeof t.title === 'string' ? t.title : '',
      assignee_hint:
        typeof t.assignee_hint === 'string' ? t.assignee_hint : undefined,
      due_hint: typeof t.due_hint === 'string' ? t.due_hint : undefined,
      evidence_quote:
        typeof t.evidence_quote === 'string' ? t.evidence_quote : undefined,
      evidence_span: pickSpanTuple(t.evidence_span),
      evidence_time:
        typeof t.evidence_time === 'string' || typeof t.evidence_time === 'number'
          ? t.evidence_time
          : undefined,
    }))
  return { raw: parsed, title, summaryMd, todos, decisions }
}

function pickSpanTuple(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined
  const a = Number(v[0])
  const b = Number(v[1])
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined
  return [Math.min(a, b), Math.max(a, b)]
}

function pickValidSpan(
  span: [number, number] | undefined,
  meetingMs: number,
): [number, number] | undefined {
  if (!span) return undefined
  const [start, end] = span
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  if (end <= start) return undefined
  // Reject obviously bogus values; clamp otherwise.
  const ceiling = Math.max(meetingMs * 2, end) // tolerate mild overshoot
  const clampedEnd = Math.min(end, ceiling)
  return [Math.max(0, Math.round(start)), Math.round(clampedEnd)]
}

// ── helpers ───────────────────────────────────────────────────────────────────

function composeSummaryMarkdown(
  body: string,
  decisions?: string[],
): string {
  let md = body.trim()
  if (decisions && decisions.length > 0) {
    const block = decisions.map((d) => `- ${d.trim()}`).join('\n')
    if (!/决定|decision/i.test(md)) {
      md = `${md}\n\n## 决定\n\n${block}`
    } else {
      // Body already has a 决定 section — leave it as the authoritative copy.
      md = `${md}\n\n_Decisions (raw):_\n\n${block}`
    }
  }
  return md
}

/**
 * Best-effort date parser for hints like "2026-10-15", "10/15", "下周三".
 * Returns undefined if we can't confidently extract a YYYY-MM-DD.
 */
function parseLooseDate(hint?: string): string | undefined {
  if (!hint) return undefined
  const isoMatch = hint.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
  if (isoMatch) {
    const [, y, m, d] = isoMatch
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
  }
  const slash = hint.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
  if (slash) {
    const year = slash[3]
      ? (slash[3].length === 2 ? `20${slash[3]}` : slash[3])
      : `${new Date().getFullYear()}`
    return `${year}-${slash[1]!.padStart(2, '0')}-${slash[2]!.padStart(2, '0')}`
  }
  // 相对日期留给 UI 处理（"下周三" / "周五之前" 等 — LLM 输出语义不明确）
  return undefined
}

/**
 * 把模型偶尔输出的 "[]" / "{}" 空标记替换为「无」。
 * 模型按 system prompt 应该对空小节写「无」，但实际输出里仍偶现空 JSON 标记；
 * 这里做最后一道兜底，保证落库的笔记里不再有孤零零的 [] / {} 行。
 * 纯函数：只替换整行 trimmed 后恰好为 "[]" / "{}"（允许前缀 "- " 或 "* "）的输入。
 */
export function tidyEmptySections(md: string): string {
  return md
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim()
      if (t === '[]' || t === '{}') return '无'
      if ((t === '- []' || t === '* []' || t === '- {}' || t === '* {}')) return '无'
      return line
    })
    .join('\n')
}
