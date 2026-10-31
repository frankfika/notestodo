import { db } from '../db/db'
import type { ID } from '../types'

/** 工作台 Chat 的引用源：笔记页面或会议（转录）。citation [n] 指向这里面的第 n 条。 */
export interface Source {
  kind: 'note' | 'meeting'
  id: ID
  title: string
  /** 截断后的正文片段，喂给 LLM 做上下文 */
  snippet: string
}

const SNIPPET_LEN = 600
const MAX_SOURCES = 6

/** 查询词切分：英文/数字按词，中文按连续串（再叠加 2-gram 提高命中） */
function tokens(q: string): string[] {
  const out: string[] = []
  for (const m of q.toLowerCase().matchAll(/[a-z0-9]+|[一-鿿]+/g)) {
    const t = m[0]
    out.push(t)
    if (/[一-鿿]/.test(t) && t.length > 2) {
      for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2))
    }
  }
  return [...new Set(out)]
}

function score(text: string, title: string, ts: string[]): number {
  const body = text.toLowerCase()
  const head = title.toLowerCase()
  let s = 0
  for (const t of ts) {
    if (head.includes(t)) s += 3
    const hits = body.split(t).length - 1
    s += Math.min(hits, 5)
  }
  return s
}

/** 关键词检索笔记 + 会议转录，按相关度取 Top-K。个人库量级，全量扫描即可。 */
export async function searchSources(query: string, attachedMeetingId?: ID | null): Promise<Source[]> {
  const ts = tokens(query)
  const [notes, meetings, transcripts] = await Promise.all([
    db.notes.filter((n) => n.deleted_at === null).toArray(),
    db.meetings.filter((m) => m.status === 'summarized' || m.status === 'transcribed').toArray(),
    db.transcripts.toArray(),
  ])
  const transcriptByMeeting = new Map(transcripts.map((t) => [t.meeting_id, t]))

  const scored: Array<{ s: number; src: Source }> = []
  for (const n of notes) {
    const text = n.body_md ?? ''
    if (attachedMeetingId && n.meeting_id !== attachedMeetingId) continue
    const s = ts.length ? score(text, n.title, ts) : 0
    if (s > 0 || !ts.length) scored.push({ s, src: { kind: 'note', id: n.id, title: n.title || '无标题', snippet: text.slice(0, SNIPPET_LEN) } })
  }
  for (const m of meetings) {
    if (attachedMeetingId && m.id !== attachedMeetingId) continue
    const t = transcriptByMeeting.get(m.id)
    const text = t?.segments.map((seg) => seg.text).join('\n') ?? ''
    if (!text) continue
    const s = ts.length ? score(text, m.title, ts) : 0
    if (s > 0 || !ts.length) scored.push({ s, src: { kind: 'meeting', id: m.id, title: m.title, snippet: text.slice(0, SNIPPET_LEN) } })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, MAX_SOURCES).map((x) => x.src)
}
