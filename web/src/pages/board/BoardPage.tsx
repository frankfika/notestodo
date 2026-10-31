import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { fmtDate, now, thisFriday, today as todayIso, uid } from '../../lib/id'
import type { Todo } from '../../types'

type Col = 'todo' | 'doing' | 'review' | 'done'
const COLS: { key: Col; label: string; dot: string }[] = [
  { key: 'todo', label: '待办', dot: 'bg-text-3' },
  { key: 'doing', label: '进行中', dot: 'bg-accent' },
  { key: 'review', label: '评审', dot: 'bg-warning' },
  { key: 'done', label: '完成', dot: 'bg-emerald-600' },
]
const FILTERS = ['全部', '来自会议', '本周到期'] as const

const colOf = (t: Todo): Col => (t.status === 'done' ? 'done' : (t.board_col ?? 'todo'))

/** 每周自动出现的「写本周周报」循环卡。确定性 id 按周去重，天然幂等（StrictMode 双跑 / 并发都安全） */
async function ensureWeeklyReportCard(): Promise<void> {
  const due = thisFriday()
  const id = `weekly-report-${due}`
  const ts = now()
  try {
    await db.todos.add({
      id, kind: 'task', parent_id: null, scope: null, title: '写本周周报', status: 'open', source: 'manual',
      due_date: due, recurring: 'weekly-report', board_col: 'todo', sort_order: Date.now(),
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
  } catch {
    // id 已存在 = 本周卡已建，忽略
  }
}

export default function BoardPage(): JSX.Element {
  const goTodos = useUI((s) => s.goTodos)
  const goReport = useUI((s) => s.goReport)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('全部')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<Col | null>(null)

  useEffect(() => { void ensureWeeklyReportCard() }, [])

  const all = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all])
  const meetings = useLiveQuery(() => db.meetings.toArray(), []) ?? []
  const meetingIds = useMemo(() => new Set(meetings.map((m) => m.id)), [meetings])

  const t0 = todayIso()
  const weekEnd = thisFriday().slice(0, 10)
  const cards = useMemo(() => {
    const doneCut = Date.now() - 14 * 86400_000 // 完成列只留最近两周，避免无限增长
    return all.filter((t) => {
      if (t.kind !== 'task' || t.deleted_at !== null) return false
      if (t.status === 'cancelled' || t.status === 'pending_review') return false
      if (t.status === 'done' && Date.parse(t.updated_at) < doneCut) return false
      if (filter === '来自会议') return t.source === 'meeting'
      if (filter === '本周到期') return !!t.due_date && t.due_date <= weekEnd
      return true
    }).sort((a, b) => a.sort_order - b.sort_order)
  }, [all, filter, weekEnd])

  const move = async (id: string, col: Col): Promise<void> => {
    const t = byId.get(id)
    if (!t || colOf(t) === col) return
    await db.todos.update(id, {
      status: col === 'done' ? 'done' : 'open',
      board_col: col === 'done' ? t.board_col : col,
      updated_at: now(), sync_version: t.sync_version + 1,
    })
  }

  const add = async (col: Col, title: string): Promise<void> => {
    const ts = now()
    await db.todos.add({
      id: uid(), kind: 'task', parent_id: null, scope: null, title, status: col === 'done' ? 'done' : 'open',
      source: 'manual', board_col: col === 'done' ? undefined : col, sort_order: Date.now(),
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
  }

  return (
    <div className="h-full flex flex-col px-6 md:px-10 pt-8 pb-6 gap-5 overflow-hidden">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <div className="section-title">任务 · 看板</div>
          <h1 className="text-2xl font-semibold tracking-tight">看板</h1>
        </div>
        <div className="ml-auto">
          <button onClick={() => useUI.getState().goTodos()} className="btn-ghost text-xs h-8 px-3">← 任务树</button>
        </div>
        <div className="w-full flex gap-2">
          {FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 h-7 rounded-full text-xs border transition-colors ${filter === f ? 'bg-accent/10 border-accent text-accent' : 'border-line text-text-2 hover:bg-bg-overlay'}`}>
              {f}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 min-h-0 flex gap-4 overflow-x-auto">
        {COLS.map((c) => {
          const list = cards.filter((t) => colOf(t) === c.key)
          return (
            <section key={c.key} data-testid={`board-col-${c.key}`}
              onDragOver={(e) => { e.preventDefault(); setOverCol(c.key) }}
              onDragLeave={() => setOverCol((o) => (o === c.key ? null : o))}
              onDrop={(e) => { e.preventDefault(); setOverCol(null); const id = e.dataTransfer.getData('text/plain') || dragId; if (id) void move(id, c.key); setDragId(null) }}
              className={`flex-1 min-w-[240px] flex flex-col rounded-2xl p-3 gap-2 bg-bg-overlay transition-shadow ${overCol === c.key ? 'ring-2 ring-accent/50' : ''}`}>
              <div className="flex items-center gap-2 px-1 pb-1">
                <span className={`h-2 w-2 rounded-full ${c.dot}`} />
                <span className="text-[13px] font-semibold">{c.label}</span>
                <span className="text-xs text-text-3 tabular-nums">{list.length}</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
                {list.map((t) => {
                  const kr = t.parent_id ? byId.get(t.parent_id) : undefined
                  const overdue = !!t.due_date && t.due_date < t0 && t.status !== 'done'
                  return (
                    <article key={t.id} draggable
                      onDragStart={(e) => { setDragId(t.id); e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move' }}
                      onClick={() => (t.recurring === 'weekly-report' ? goReport() : goTodos(t.id))}
                      className={`card p-3 cursor-pointer hover:shadow-md transition-shadow ${t.recurring ? 'border-accent/60' : ''} ${dragId === t.id ? 'opacity-40' : ''}`}>
                      <div className={`text-sm leading-snug ${t.status === 'done' ? 'line-through text-text-3' : ''}`}>
                        {t.recurring && <span className="text-accent mr-1">↻</span>}{t.title}
                      </div>
                      <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[11px]">
                        {kr && <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent truncate max-w-[140px]">{kr.title}</span>}
                        {t.recurring && <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">草稿已生成</span>}
                        {t.source === 'meeting' && t.meeting_id && meetingIds.has(t.meeting_id) && <span className="px-1.5 py-0.5 rounded bg-bg-overlay text-text-3">● 会议</span>}
                        {t.due_date && <span className={`ml-auto ${overdue ? 'text-danger' : 'text-text-3'}`}>{fmtDate(t.due_date)}</span>}
                      </div>
                    </article>
                  )
                })}
                {list.length === 0 && <div className="text-xs text-text-3 text-center py-6">拖卡片到这里</div>}
              </div>
              <QuickAdd onAdd={(title) => add(c.key, title)} />
            </section>
          )
        })}
      </div>
    </div>
  )
}

function QuickAdd({ onAdd }: { onAdd: (title: string) => Promise<void> }): JSX.Element {
  const [v, setV] = useState('')
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} placeholder="+ 添加卡片，回车确认"
      onKeyDown={(e) => { if (e.key === 'Enter' && v.trim() && !e.nativeEvent.isComposing) { void onAdd(v.trim()); setV('') } }}
      className="input !bg-transparent !border-transparent hover:!border-line focus:!bg-bg-raise text-[13px]" />
  )
}
