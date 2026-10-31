import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import { db } from '../../db/db'
import { now, thisFriday, today as todayIso } from '../../lib/id'
import type { Todo } from '../../types'
import { EditableTitle, TodoMenu } from './todoRowOps'

const live = (t: Todo): boolean => t.deleted_at === null && t.status !== 'cancelled'

type GroupKey = 'overdue' | 'today' | 'week' | 'later' | 'none'
const GROUPS: { key: GroupKey; label: string; cls: string }[] = [
  { key: 'overdue', label: '已过期', cls: 'text-red-500' },
  { key: 'today', label: '今天', cls: 'text-accent' },
  { key: 'week', label: '本周', cls: 'text-text-2' },
  { key: 'later', label: '稍后', cls: 'text-text-2' },
  { key: 'none', label: '无日期', cls: 'text-text-3' },
]

function groupOf(t: Todo, today: string, weekEnd: string): GroupKey {
  if (!t.due_date) return 'none'
  if (t.due_date < today) return 'overdue'
  if (t.due_date === today) return 'today'
  if (t.due_date <= weekEnd) return 'week'
  return 'later'
}

function fmtDue(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}

async function toggle(t: Todo): Promise<void> {
  await db.todos.update(t.id, {
    status: t.status === 'done' ? 'open' : 'done',
    updated_at: now(),
    sync_version: t.sync_version + 1,
  })
}

function Row({ t, byId, all }: { t: Todo; byId: Map<string, Todo>; all: Todo[] }): JSX.Element {
  const crumbs: string[] = []
  let p = t.parent_id ? byId.get(t.parent_id) : undefined
  const seen = new Set<string>()
  while (p && !seen.has(p.id)) {
    seen.add(p.id)
    crumbs.unshift(p.title || '（无标题）')
    p = p.parent_id ? byId.get(p.parent_id) : undefined
  }
  const g = groupOf(t, todayIso(), thisFriday().slice(0, 10))
  const dueCls = g === 'overdue' ? 'text-red-500' : g === 'today' ? 'text-accent' : 'text-text-3'

  return (
    <div className="group flex items-center gap-2 h-9 px-2 rounded-[8px] hover:bg-bg-overlay transition-colors">
      <input
        type="checkbox"
        checked={t.status === 'done'}
        onChange={() => void toggle(t)}
        className="shrink-0 accent-[var(--accent)]"
      />
      <div className="flex-1 min-w-0">
        <EditableTitle t={t} className={`block truncate text-sm ${t.status === 'done' ? 'line-through text-text-3' : 'text-text-1'}`} />
        {crumbs.length > 0 && (
          <div className="truncate text-[11px] text-text-3">{crumbs.join(' › ')}</div>
        )}
      </div>
      {t.due_date && <span className={`text-[11px] font-mono shrink-0 ${dueCls}`}>{fmtDue(t.due_date)}</span>}
      <TodoMenu t={t} all={all} />
    </div>
  )
}

export default function TodosList(): JSX.Element {
  const all = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all])
  const today = todayIso()
  const weekEnd = thisFriday().slice(0, 10)

  const grouped = useMemo(() => {
    const map = new Map<GroupKey, Todo[]>()
    for (const t of all.filter(live)) {
      const g = groupOf(t, today, weekEnd)
      map.set(g, [...(map.get(g) ?? []), t])
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.sort_order - b.sort_order)
    }
    return map
  }, [all, today, weekEnd])

  return (
    <div className="flex flex-col gap-4">
      {GROUPS.map(({ key, label, cls }) => {
        const list = grouped.get(key) ?? []
        if (list.length === 0) return null
        return (
          <section key={key}>
            <div className={`section-title flex items-center gap-2 ${cls}`}>
              {label} <span className="text-text-3 font-normal normal-case tracking-normal">{list.length}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              {list.map((t) => <Row key={t.id} t={t} byId={byId} all={all} />)}
            </div>
          </section>
        )
      })}
      {all.filter(live).length === 0 && <div className="text-sm text-text-3 py-8 text-center">还没有任务</div>}
    </div>
  )
}
