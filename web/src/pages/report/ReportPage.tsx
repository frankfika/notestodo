import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db } from '../../db/db'
import { rollupProgress } from '../../lib/okr'
import MarkdownView from '../../components/MarkdownView'
import type { Todo } from '../../types'

const p2 = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
const md = (s: string) => `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日`

/** 周一 00:00 起的一周 [start, nextStart) */
function weekRange(offset: number): { start: Date; end: Date } {
  const d = new Date()
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) + offset * 7)
  return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) }
}

/** 数据整合：本周完成的卡片 + 会议 + KR 进度 → Markdown 草稿。纯函数，便于测试。 */
export function buildReport(todos: Todo[], meetings: { title: string; started_at: string }[], range: { start: Date; end: Date }, todayStr: string): string {
  const live = todos.filter((t) => t.deleted_at === null)
  const byId = new Map(live.map((t) => [t.id, t]))
  const inWeek = (iso: string) => Date.parse(iso) >= range.start.getTime() && Date.parse(iso) < range.end.getTime()
  const done = live.filter((t) => t.kind === 'task' && t.status === 'done' && inWeek(t.updated_at))
  const progress = rollupProgress(live)
  const nextStart = ymd(range.end)
  const nextEnd = ymd(new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() + 6))
  const open = live.filter((t) => t.kind === 'task' && t.status === 'open' && !t.recurring)
  const overdue = open.filter((t) => t.due_date && t.due_date < todayStr)
  const next = open.filter((t) => t.due_date && t.due_date >= nextStart && t.due_date <= nextEnd)
  const wk = meetings.filter((m) => inWeek(m.started_at))

  const byKr = new Map<string, Todo[]>()
  for (const t of done) {
    const key = t.parent_id && byId.get(t.parent_id) ? t.parent_id : ''
    byKr.set(key, [...(byKr.get(key) ?? []), t])
  }
  const lines: string[] = []
  lines.push(`## 本周总结`, `完成 ${done.length} 张卡片，开了 ${wk.length} 场会议。`, '')
  lines.push('## 关键进展')
  if (done.length === 0) lines.push('- 本周暂无已完成的卡片')
  for (const [k, ts] of byKr) {
    const kr = k ? byId.get(k) : undefined
    const pct = kr ? ` （进度 ${Math.round((progress.get(kr.id) ?? 0) * 100)}%）` : ''
    lines.push(`- **${kr ? kr.title : '日常事务'}**${pct}`)
    for (const t of ts) lines.push(`  - ${t.title}`)
  }
  lines.push('', '## 会议')
  if (wk.length === 0) lines.push('- 本周没有会议')
  for (const m of wk) lines.push(`- ${md(m.started_at.slice(0, 10))} ${m.title}`)
  lines.push('', '## 风险与阻塞')
  if (overdue.length === 0) lines.push('- 暂无逾期事项')
  for (const t of overdue) lines.push(`- ${t.title}（${md(t.due_date!)} 到期，已逾期）`)
  lines.push('', '## 下周计划')
  if (next.length === 0) lines.push('- 下周暂无带截止日的卡片')
  for (const t of next) lines.push(`- ${t.title}（${md(t.due_date!)}）`)
  return lines.join('\n')
}

export default function ReportPage(): JSX.Element {
  const [offset, setOffset] = useState(0)
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)
  const todos = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const meetings = useLiveQuery(() => db.meetings.toArray(), []) ?? []
  const range = useMemo(() => weekRange(offset), [offset])
  const doc = useMemo(
    () => buildReport(todos, meetings.filter((m) => m.deleted_at === null), range, ymd(new Date())) + (note.trim() ? `\n\n## 补充\n${note.trim()}` : ''),
    [todos, meetings, range, note],
  )
  const last = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() - 1)

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(doc)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="h-full flex flex-col px-6 md:px-12 pt-8 pb-6 gap-5 overflow-hidden">
      <header className="flex items-end gap-4">
        <div>
          <div className="text-xs text-text-3">{md(ymd(range.start))} – {md(ymd(last))}{offset === 0 ? ' · 本周' : ''}</div>
          <h1 className="text-2xl font-semibold tracking-tight">周报</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button className="btn-outline h-9" onClick={() => setOffset((o) => o - 1)} aria-label="上一周">‹</button>
          <button className="btn-outline h-9" onClick={() => setOffset(0)} disabled={offset === 0}>本周</button>
          <button className="btn-outline h-9" onClick={() => setOffset((o) => o + 1)} aria-label="下一周">›</button>
          <button className="btn-primary h-9 px-4" onClick={() => void copy()}>{copied ? '已复制 ✓' : '复制 Markdown'}</button>
        </div>
      </header>
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-6">
        <article data-testid="report-doc" className="card flex-1 min-h-0 overflow-y-auto px-8 py-6">
          <MarkdownView source={doc} />
        </article>
        <aside className="lg:w-[300px] shrink-0 flex flex-col gap-2">
          <label className="label" htmlFor="report-note">补充说明（会追加到周报末尾）</label>
          <textarea id="report-note" className="input min-h-[120px] resize-y" value={note} onChange={(e) => setNote(e.target.value)} placeholder="手写的亮点、感想、需要协调的事…" />
          <p className="text-xs text-text-3 leading-relaxed mt-2">数据来自本周完成的卡片、会议和 OKR 进度，自动汇总，无需手填。复制后可直接粘贴到飞书文档。</p>
        </aside>
      </div>
    </div>
  )
}
