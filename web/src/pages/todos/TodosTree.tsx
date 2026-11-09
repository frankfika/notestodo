import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { db } from '../../db/db'
import { now, today as todayIso, uid } from '../../lib/id'
import { useUI } from '../../state/ui'
import type { Tag, Todo } from '../../types'
import OriginChip from '../../components/OriginChip'
import TodoTags from './TodoTags'
import { EditableTitle, TodoMenu } from './todoRowOps'
import { doneLast, filterForTree, type TodoFilter } from './filter'
import { useOriginTitles, type OriginTitles } from '../../lib/originTitles'

const live = (t: Todo): boolean => t.deleted_at === null && t.status !== 'cancelled'

function fmtDue(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}

function DueBadge({ due }: { due?: string }): JSX.Element | null {
  if (!due) return null
  const t = todayIso()
  const cls = due < t ? 'text-red-500' : due === t ? 'text-accent' : 'text-text-3'
  return <span className={`text-[11px] font-mono ${cls}`}>{fmtDue(due)}</span>
}

async function toggle(t: Todo): Promise<void> {
  await db.todos.update(t.id, {
    status: t.status === 'done' ? 'open' : 'done',
    updated_at: now(),
    sync_version: t.sync_version + 1,
  })
}

async function addChild(parent: Todo): Promise<void> {
  const ts = now()
  await db.todos.add({
    id: uid(), kind: 'task', parent_id: parent.id, scope: parent.scope ?? null,
    title: '', status: 'open', source: 'manual', sort_order: Date.now(),
    created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
  })
}

/** 防止把节点拖进自己的子孙里成环 */
function isDescendant(nodeId: string, maybeAncestorId: string, byId: Map<string, Todo>): boolean {
  let p = byId.get(maybeAncestorId)?.parent_id
  const seen = new Set<string>()
  while (p && !seen.has(p)) {
    if (p === nodeId) return true
    seen.add(p)
    p = byId.get(p)?.parent_id ?? null
  }
  return false
}

interface Node { todo: Todo; children: Node[]; done: number; total: number }

function buildTree(all: Todo[]): Node[] {
  const byParent = new Map<string | null, Todo[]>()
  const liveTodos = all.filter(live)
  for (const t of liveTodos) {
    const k = t.parent_id ?? null
    const arr = byParent.get(k)
    if (arr) arr.push(t)
    else byParent.set(k, [t])
  }
  const byId = new Map(all.map((t) => [t.id, t]))
  const make = (t: Todo): Node => {
    const children = (byParent.get(t.id) ?? [])
      .sort((a, b) => doneLast(a, b) || a.sort_order - b.sort_order)
      .map(make)
    // 子树进度自底向上一次算完：原来每个 Row 各自递归一遍整棵子树（O(n·depth)）
    let done = t.status === 'done' ? 1 : 0
    let total = 1
    for (const c of children) { done += c.done; total += c.total }
    return { todo: t, children, done, total }
  }
  const roots = (byParent.get(null) ?? []).filter((t) => !t.parent_id || !byId.has(t.parent_id) || !live(byId.get(t.parent_id)!))
  // 孤儿（父被删）也提到根层，避免从树里消失
  const orphans = liveTodos.filter((t) => t.parent_id && (!byId.has(t.parent_id) || !live(byId.get(t.parent_id)!)))
  return [...roots.filter((t) => !t.parent_id), ...orphans]
    .sort((a, b) => doneLast(a, b) || a.sort_order - b.sort_order)
    .map(make)
}

function Row({ node, depth, collapsed, setCollapsed, dragId, setDragId, byId, all, tagByTodo, tagsById, origins, readOnly }: {
  node: Node
  depth: number
  collapsed: Set<string>
  setCollapsed: (fn: (s: Set<string>) => Set<string>) => void
  dragId: string | null
  setDragId: (id: string | null) => void
  byId: Map<string, Todo>
  all: Todo[]
  tagByTodo: Map<string, string[]>
  tagsById: Map<string, Tag>
  origins: OriginTitles
  readOnly?: boolean
}): JSX.Element {
  const [over, setOver] = useState(false)
  const t = node.todo
  const focused = useUI((s) => s.todoFocusId === t.id)
  const hasKids = node.children.length > 0
  const subTotal = node.total - 1
  const subDone = node.done - (t.status === 'done' ? 1 : 0)

  const onDrop = async (): Promise<void> => {
    if (readOnly) return
    setOver(false)
    if (!dragId || dragId === t.id) return
    const dragged = byId.get(dragId)
    if (!dragged || isDescendant(dragId, t.id, byId)) return
    const last = Math.max(0, ...node.children.map((c) => c.todo.sort_order))
    await db.todos.update(dragId, {
      parent_id: t.id, sort_order: last + 10, updated_at: now(), sync_version: dragged.sync_version + 1,
    })
    setDragId(null)
  }

  return (
    <>
      <div
        draggable={!readOnly}
        onDragStart={(e) => { if (readOnly) return; setDragId(t.id); e.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={() => setDragId(null)}
        onDragOver={(e) => { if (readOnly) return; e.preventDefault(); if (dragId && dragId !== t.id) setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={() => void onDrop()}
        data-todo={t.id}
        className={`group flex items-center gap-1.5 h-9 pr-2 rounded-[8px] transition-colors ${over ? 'bg-accent/10 outline outline-1 outline-accent' : 'hover:bg-bg-overlay'} ${dragId === t.id ? 'opacity-40' : ''} ${focused ? 'bg-accent/10' : ''}`}
        style={{ paddingLeft: depth * 20 + (depth > 0 ? 8 : 4) }}
      >
        {depth > 0 && <span className="self-stretch border-l border-line -ml-2 mr-1" />}
        <button
          onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n })}
          className={`w-4 h-4 shrink-0 text-text-3 text-[10px] leading-none ${hasKids ? '' : 'invisible'}`}
        >{collapsed.has(t.id) ? '▸' : '▾'}</button>
        <input
          type="checkbox"
          checked={t.status === 'done'}
          disabled={readOnly}
          onChange={() => void toggle(t)}
          className="shrink-0 accent-[var(--accent)]"
        />
        {readOnly ? (
          <span className={`flex-1 truncate text-sm ${t.status === 'done' ? 'line-through text-text-3' : 'text-text-1'}`}>{t.title}</span>
        ) : (
          <EditableTitle t={t} className={`flex-1 truncate text-sm ${t.status === 'done' ? 'line-through text-text-3' : 'text-text-1'}`} />
        )}
        {subTotal > 0 && <span className="text-[11px] text-text-3 shrink-0">{subDone}/{subTotal}</span>}
        <TodoTags ids={tagByTodo.get(t.id) ?? []} tagsById={tagsById} />
        <OriginChip t={t}
          noteTitle={t.origin_note_id ? origins.noteTitles.get(t.origin_note_id) : undefined}
          meetingTitle={t.meeting_id ? origins.meetingTitles.get(t.meeting_id) : undefined} />
        <DueBadge due={t.due_date} />
        {!readOnly && (
          <>
            <button
              onClick={() => void addChild(t)}
              title="新建子任务"
              className="w-6 h-6 rounded-[6px] text-text-3 opacity-0 group-hover:opacity-100 hover:bg-bg-raise hover:text-text-1 transition-opacity"
            >＋</button>
            <TodoMenu t={t} all={all} />
          </>
        )}
      </div>
      {!collapsed.has(t.id) && node.children.map((c) => (
        <Row key={c.todo.id} node={c} depth={depth + 1} collapsed={collapsed} setCollapsed={setCollapsed}
          dragId={dragId} setDragId={setDragId} byId={byId} all={all} tagByTodo={tagByTodo} tagsById={tagsById}
          origins={origins} readOnly={readOnly} />
      ))}
    </>
  )
}

export default function TodosTree({ filter, tagByTodo, readOnly }: { filter: TodoFilter; tagByTodo: Map<string, string[]>; readOnly?: boolean }): JSX.Element {
  const all = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const tags = useLiveQuery(() => db.tags.toArray(), []) ?? []
  const tagsById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all])
  const tree = useMemo(() => buildTree(filterForTree(all, filter, tagByTodo)), [all, filter, tagByTodo])
  const origins = useOriginTitles(all)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  const focusId = useUI((s) => s.todoFocusId)

  // 从看板等跳进来：展开祖先 + 滚到该行。消费一次就清掉 focusId，避免 effect 反复跑
  useEffect(() => {
    if (!focusId) return
    useUI.setState({ todoFocusId: null })
    setCollapsed((s) => {
      const n = new Set(s)
      let p = byId.get(focusId)?.parent_id
      while (p) { n.delete(p); p = byId.get(p)?.parent_id ?? null }
      return n
    })
    const t = setTimeout(() => document.querySelector(`[data-todo="${focusId}"]`)?.scrollIntoView({ block: 'center' }), 50)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  const addRoot = async (): Promise<void> => {
    const ts = now()
    await db.todos.add({
      id: uid(), kind: 'task', parent_id: null, scope: null, title: '', status: 'open',
      source: 'manual', sort_order: Date.now(), created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
  }

  return (
    <div className="flex flex-col gap-0.5">
      {tree.map((n) => (
        <Row key={n.todo.id} node={n} depth={0} collapsed={collapsed} setCollapsed={setCollapsed}
          dragId={dragId} setDragId={setDragId} byId={byId} all={all} tagByTodo={tagByTodo} tagsById={tagsById}
          origins={origins} readOnly={readOnly} />
      ))}
      {tree.length === 0 && (
        <div className="text-sm text-text-3 py-8 text-center">
          {all.some(live) ? '没有符合条件的任务' : '还没有任务'}
        </div>
      )}
      {!readOnly && (
        <button onClick={() => void addRoot()} className="btn-ghost self-start mt-2">＋ 新建任务</button>
      )}
    </div>
  )
}
