import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../../db/db'
import { now, today as todayIso } from '../../lib/id'
import { useUI } from '../../state/ui'
import type { Tag, Todo } from '../../types'
import OriginChip from '../../components/OriginChip'
import TodoTags from './TodoTags'
import { EditableTitle, TodoMenu, createTodo, useRowKeys } from './todoRowOps'
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
    let done = t.status === 'done' ? 1 : 0
    let total = 1
    for (const c of children) { done += c.done; total += c.total }
    return { todo: t, children, done, total }
  }
  const roots = (byParent.get(null) ?? []).filter((t) => !t.parent_id || !byId.has(t.parent_id) || !live(byId.get(t.parent_id)!))
  const orphans = liveTodos.filter((t) => t.parent_id && (!byId.has(t.parent_id) || !live(byId.get(t.parent_id)!)))
  return [...roots.filter((t) => !t.parent_id), ...orphans]
    .sort((a, b) => doneLast(a, b) || a.sort_order - b.sort_order)
    .map(make)
}

/** 落点模式：上 30% 插到前面 / 下 30% 插到后面（同级排序）；中间 40% 挂为子任务 */
type DropMode = 'before' | 'after' | 'into'

function Row({ node, depth, siblings, collapsed, setCollapsed, dragId, setDragId, byId, all, tagByTodo, tagsById, origins, tabbable, setActiveId, readOnly }: {
  node: Node
  depth: number
  /** 同级节点（含自己），用于排序落点计算 */
  siblings: Node[]
  collapsed: Set<string>
  setCollapsed: (fn: (s: Set<string>) => Set<string>) => void
  dragId: string | null
  setDragId: (id: string | null) => void
  byId: Map<string, Todo>
  all: Todo[]
  tagByTodo: Map<string, string[]>
  tagsById: Map<string, Tag>
  origins: OriginTitles
  /** roving tabindex：只有这一行能 Tab 进入 */
  tabbable: boolean
  setActiveId: (id: string) => void
  /** 脑图开启时大纲只读（R3 单一编辑真相源） */
  readOnly?: boolean
}): JSX.Element {
  const [drop, setDrop] = useState<DropMode | null>(null)
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const t = node.todo
  const focused = useUI((s) => s.todoFocusId === t.id)
  const hasKids = node.children.length > 0
  const subTotal = node.total - 1
  const subDone = node.done - (t.status === 'done' ? 1 : 0)

  // 拖拽结束时清掉残留指示
  useEffect(() => { if (!dragId) setDrop(null) }, [dragId])

  const clearExpandTimer = (): void => {
    if (expandTimer.current) { clearTimeout(expandTimer.current); expandTimer.current = null }
  }

  /** 当前拖拽是否能落在本行（不能落到自己或自己的子孙上） */
  const canDrop = (): boolean =>
    !readOnly && !!dragId && dragId !== t.id && !isDescendant(dragId, t.id, byId)

  const onDragOver = (e: React.DragEvent): void => {
    if (!canDrop()) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientY - rect.top) / rect.height
    const mode: DropMode = ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'into'
    setDrop(mode)
    // 拖到折叠的父任务上悬停一会儿 → 自动展开（Notion/飞书同款）
    clearExpandTimer()
    if (mode === 'into' && hasKids && collapsed.has(t.id)) {
      expandTimer.current = setTimeout(() => {
        setCollapsed((s) => { const n = new Set(s); n.delete(t.id); return n })
      }, 700)
    }
  }

  const onDrop = async (): Promise<void> => {
    clearExpandTimer()
    const mode = drop
    setDrop(null)
    if (!dragId || !mode || !canDrop()) return
    const dragged = byId.get(dragId)
    if (!dragged) return

    if (mode === 'into') {
      const last = Math.max(0, ...node.children.map((c) => c.todo.sort_order))
      await db.todos.update(dragId, {
        parent_id: t.id, sort_order: last + 10, updated_at: now(), sync_version: dragged.sync_version + 1,
      })
      setCollapsed((s) => { const n = new Set(s); n.delete(t.id); return n })
    } else {
      // 同级插入：取目标行前后邻居的 sort_order 中点（跳过被拖行自身）
      const sibs = siblings.map((n) => n.todo).filter((x) => x.id !== dragId)
      const idx = sibs.findIndex((x) => x.id === t.id)
      let order: number
      if (mode === 'before') {
        const prev = sibs[idx - 1]
        order = prev ? (prev.sort_order + t.sort_order) / 2 : t.sort_order - 10
      } else {
        const next = sibs[idx + 1]
        order = next ? (next.sort_order + t.sort_order) / 2 : t.sort_order + 10
      }
      await db.todos.update(dragId, {
        parent_id: t.parent_id ?? null, sort_order: order, updated_at: now(), sync_version: dragged.sync_version + 1,
      })
    }
    setDragId(null)
  }

  const addChild = async (): Promise<void> => {
    setCollapsed((s) => { const n = new Set(s); n.delete(t.id); return n })
    await createTodo(t)
  }

  return (
    <>
      <div
        onDragOver={onDragOver}
        onDragLeave={() => { clearExpandTimer(); setDrop(null) }}
        onDrop={() => void onDrop()}
        data-todo={t.id}
        tabIndex={tabbable ? 0 : -1}
        onFocus={() => setActiveId(t.id)}
        className={`group relative flex items-center gap-1.5 h-9 pr-2 rounded-[8px] transition-colors outline-none focus-visible:bg-bg-overlay ${drop === 'into' ? 'bg-accent/10' : 'hover:bg-bg-overlay'} ${dragId === t.id ? 'opacity-40' : ''} ${focused ? 'bg-accent/10' : ''}`}
        style={{
          paddingLeft: 4 + depth * 24,
          // 插入位置指示线（复用笔记编辑器的视觉语言：accent 内嵌线）
          ...(drop === 'before' ? { boxShadow: 'inset 0 2px 0 var(--accent)' } : {}),
          ...(drop === 'after' ? { boxShadow: 'inset 0 -2px 0 var(--accent)' } : {}),
        }}
      >
        {/* 层级引导线：每一级祖先箭头正下方一条竖线，兄弟行间连成连续线（Notion 大纲样式） */}
        {Array.from({ length: depth }, (_, k) => (
          <span key={k} aria-hidden className="absolute top-0 bottom-0 w-px bg-line pointer-events-none" style={{ left: 24 + k * 24 }} />
        ))}
        {/* 拖拽手柄：只有按住它才能拖，标题区恢复文本选择/点击编辑（Notion ⠿ 同款） */}
        <span
          data-drag-handle
          draggable={!readOnly}
          onDragStart={(e) => {
            if (readOnly) return
            setDragId(t.id)
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', t.id)
          }}
          onDragEnd={() => { clearExpandTimer(); setDragId(null) }}
          title="拖拽排序 / 拖到任务上成为子任务"
          className={`w-3 shrink-0 cursor-grab active:cursor-grabbing text-text-3 text-[10px] leading-none select-none opacity-0 group-hover:opacity-100 max-md:hidden transition-opacity ${readOnly ? 'invisible' : ''}`}
        >⠿</span>
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
          <EditableTitle
            t={t}
            all={all}
            className={`flex-1 truncate text-sm ${t.status === 'done' ? 'line-through text-text-3' : 'text-text-1'}`}
          />
        )}
        {subTotal > 0 && <span className="text-[11px] text-text-3 shrink-0">{subDone}/{subTotal}</span>}
        <TodoTags ids={tagByTodo.get(t.id) ?? []} tagsById={tagsById} />
        {/* 来源链接降噪：hover 才显示，平时不占视觉 */}
        <span className="hover-only opacity-0 group-hover:opacity-100 transition-opacity flex items-center">
          <OriginChip t={t}
            noteTitle={t.origin_note_id ? origins.noteTitles.get(t.origin_note_id) : undefined}
            meetingTitle={t.meeting_id ? origins.meetingTitles.get(t.meeting_id) : undefined} />
        </span>
        <DueBadge due={t.due_date} />
        {!readOnly && (
          <>
            <button
              onClick={() => void addChild()}
              title="新建子任务"
              className="hover-only w-6 h-6 rounded-[6px] text-text-3 opacity-0 group-hover:opacity-100 hover:bg-bg-raise hover:text-text-1 transition-opacity"
            >＋</button>
            <TodoMenu t={t} all={all} />
          </>
        )}
      </div>
      {!collapsed.has(t.id) && node.children.map((c) => (
        <Row key={c.todo.id} node={c} depth={depth + 1} siblings={node.children}
          collapsed={collapsed} setCollapsed={setCollapsed}
          dragId={dragId} setDragId={setDragId} byId={byId} all={all} tagByTodo={tagByTodo} tagsById={tagsById}
          origins={origins} tabbable={false} setActiveId={setActiveId} readOnly={readOnly} />
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
  const [activeId, setActiveId] = useState<string | null>(null)
  const focusId = useUI((s) => s.todoFocusId)

  const containerRef = useRef<HTMLDivElement>(null)
  const onKeyDown = useRowKeys(containerRef, all, readOnly)

  // roving tabindex：没有手动选中过就默认第一行可 Tab 进入
  const tabbableId = activeId ?? tree[0]?.todo.id ?? null

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
    await createTodo(null)
  }

  return (
    <div ref={containerRef} onKeyDown={onKeyDown} className="flex flex-col gap-0.5">
      {tree.map((n) => (
        <Row key={n.todo.id} node={n} depth={0} siblings={tree}
          collapsed={collapsed} setCollapsed={setCollapsed}
          dragId={dragId} setDragId={setDragId} byId={byId} all={all} tagByTodo={tagByTodo} tagsById={tagsById}
          origins={origins} tabbable={tabbableId === n.todo.id}
          setActiveId={setActiveId} readOnly={readOnly} />
      ))}
      {tree.length === 0 && (
        <div className="text-sm text-text-3 py-8 text-center">
          {all.some(live) ? '没有符合条件的任务' : '还没有任务，点击下方添加'}
        </div>
      )}
      {!readOnly && (
        <button
          onClick={() => void addRoot()}
          className="self-start mt-2 px-2 h-9 rounded-[8px] text-sm text-text-3 hover:bg-bg-overlay hover:text-text-1 transition-colors"
        >＋ 添加任务</button>
      )}
    </div>
  )
}
