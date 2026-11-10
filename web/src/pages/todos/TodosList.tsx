import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useRef, useState } from 'react'
import { db } from '../../db/db'
import { now, thisFriday, today as todayIso } from '../../lib/id'
import type { Tag, Todo } from '../../types'
import OriginChip from '../../components/OriginChip'
import TodoTags from './TodoTags'
import { EditableTitle, TodoMenu, createTodo, useRowKeys } from './todoRowOps'
import { doneLast, passFilter, type TodoFilter } from './filter'
import { useOriginTitles } from '../../lib/originTitles'
import { applyTodoStatus } from '../../lib/todoStatus'

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

/** 完成日期（ISO 时间戳 → 11/10） */
function fmtCompleted(iso: string): string {
  return fmtDue(iso.slice(0, 10))
}

async function toggle(t: Todo): Promise<void> {
  await applyTodoStatus(t, t.status === 'done' ? 'open' : 'done')
}

function Row({ t, byId, all, tagByTodo, tagsById, noteTitle, meetingTitle, tabbable, setActiveId }: {
  t: Todo
  byId: Map<string, Todo>
  all: Todo[]
  tagByTodo: Map<string, string[]>
  tagsById: Map<string, Tag>
  noteTitle?: string
  meetingTitle?: string
  tabbable: boolean
  setActiveId: (id: string) => void
}): JSX.Element {
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
    <div
      data-todo={t.id}
      tabIndex={tabbable ? 0 : -1}
      onFocus={() => setActiveId(t.id)}
      className="group flex items-center gap-2 h-9 px-2 rounded-[8px] hover:bg-bg-overlay focus-visible:bg-bg-overlay outline-none transition-colors"
    >
      <input
        type="checkbox"
        checked={t.status === 'done'}
        onChange={() => void toggle(t)}
        className="shrink-0 accent-[var(--accent)]"
      />
      <div className="flex-1 min-w-0">
        <EditableTitle
          t={t}
          className={`block truncate text-sm ${
            t.status === 'done' || t.status === 'cancelled' ? 'line-through text-text-3' : 'text-text-1'
          }`}
        />
        {crumbs.length > 0 && (
          <div className="truncate text-[11px] text-text-3">{crumbs.join(' › ')}</div>
        )}
      </div>
      <TodoTags ids={tagByTodo.get(t.id) ?? []} tagsById={tagsById} />
      {/* 关联人 + 完成日期：把「谁 · 什么时候 · 完成了什么」串在一行里 */}
      {t.assignee && (
        <span className="text-[11px] text-text-2 shrink-0" title="关联人（在「⋯」里改）">@{t.assignee}</span>
      )}
      {t.completed_at && (
        <span className="text-[11px] font-mono text-text-3 shrink-0" title="完成日期">完成 {fmtCompleted(t.completed_at)}</span>
      )}
      {t.archived_at && (
        <span className="text-[11px] font-mono text-text-3 shrink-0" title="归档日期">归档 {fmtCompleted(t.archived_at)}</span>
      )}
      <span className="hover-only opacity-0 group-hover:opacity-100 transition-opacity flex items-center">
        <OriginChip t={t} noteTitle={noteTitle} meetingTitle={meetingTitle} />
      </span>
      {t.due_date && <span className={`text-[11px] font-mono shrink-0 ${dueCls}`}>{fmtDue(t.due_date)}</span>}
      <TodoMenu t={t} all={all} />
    </div>
  )
}

export default function TodosList({ filter, tagByTodo }: { filter: TodoFilter; tagByTodo: Map<string, string[]> }): JSX.Element {
  const all = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const tags = useLiveQuery(() => db.tags.toArray(), []) ?? []
  const tagsById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all])
  const origins = useOriginTitles(all)
  const today = todayIso()
  const weekEnd = thisFriday().slice(0, 10)
  const [activeId, setActiveId] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const onKeyDown = useRowKeys(containerRef, all)

  const visible = useMemo(() => {
    // 「已归档」视图看的是被关闭掉的那批（它们平时被 live() 滤掉）
    if (filter.status === 'archived') {
      return all
        .filter((t) => t.deleted_at === null && t.status === 'cancelled')
        .filter((t) => passFilter(t, filter, tagByTodo))
    }
    return all.filter(live).filter((t) => passFilter(t, filter, tagByTodo))
  }, [all, filter, tagByTodo])
  const grouped = useMemo(() => {
    const map = new Map<GroupKey, Todo[]>()
    for (const t of visible) {
      const g = groupOf(t, today, weekEnd)
      const arr = map.get(g)
      if (arr) arr.push(t)
      else map.set(g, [t])
    }
    for (const list of map.values()) {
      list.sort((a, b) => doneLast(a, b) || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.sort_order - b.sort_order)
    }
    return map
  }, [visible, today, weekEnd])

  // roving tabindex：默认第一行可 Tab 进入
  const firstVisible = visible[0]?.id ?? null
  const tabbableId = activeId ?? firstVisible

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="flex flex-col gap-4">
      {GROUPS.map(({ key, label, cls }) => {
        const list = grouped.get(key) ?? []
        if (list.length === 0) return null
        return (
          <section key={key}>
            <div className={`section-title flex items-center gap-2 ${cls}`}>
              {label} <span className="text-text-3 font-normal normal-case tracking-normal">{list.length}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              {list.map((t) => (
                <Row key={t.id} t={t} byId={byId} all={all} tagByTodo={tagByTodo} tagsById={tagsById}
                  noteTitle={t.origin_note_id ? origins.noteTitles.get(t.origin_note_id) : undefined}
                  meetingTitle={t.meeting_id ? origins.meetingTitles.get(t.meeting_id) : undefined}
                  tabbable={tabbableId === t.id} setActiveId={setActiveId} />
              ))}
            </div>
          </section>
        )
      })}
      {visible.length === 0 && (
        <div className="text-sm text-text-3 py-8 text-center">
          {all.some(live) ? '没有符合条件的任务' : '还没有任务，点击下方添加'}
        </div>
      )}
      <button
        onClick={() => void createTodo(null)}
        className="self-start mt-1 px-2 h-9 rounded-[8px] text-sm text-text-3 hover:bg-bg-overlay hover:text-text-1 transition-colors"
      >＋ 添加任务</button>
    </div>
  )
}
