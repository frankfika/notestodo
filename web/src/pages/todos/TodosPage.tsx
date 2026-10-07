import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { now, uid } from '../../lib/id'
import { useUI } from '../../state/ui'
import type { Todo, TodoKind, TodoStatus } from '../../types'
import EmptyState from '../../components/EmptyState'
import TagPicker from '../../components/TagPicker'

type Filter = '全部' | '进行' | '今日' | '已完成'

const STATUS_LABELS: Record<TodoStatus, string> = {
  open: '进行中',
  done: '已完成',
  cancelled: '已取消',
  pending_review: '待审',
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 三级任务视图（Things 3 风格，单列缩进分组）：
 *   自由任务 (task, parent_id=null)
 *   Objective  →  KR  →  Task
 *
 * 顶部筛选 pills (全部/进行/今日/已完成)。
 * 任务行 hover 出现编辑 popover（title/due/assignee/tags/parent 切换）。
 */
export default function TodosPage(): JSX.Element {
  const todos = useLiveQuery(
    () => db.todos.toArray(),
    [],
  ) ?? []
  const focusId = useUI((s) => s.todoFocusId)

  const [filter, setFilter] = useState<Filter>('全部')

  const counts = useMemo(() => {
    const t = todayIso()
    return {
      all: todos.filter((x) => x.deleted_at === null).length,
      open: todos.filter((x) => x.status === 'open' || x.status === 'pending_review').length,
      today: todos.filter((x) => x.due_date === t && (x.status === 'open' || x.status === 'pending_review')).length,
      done: todos.filter((x) => x.status === 'done').length,
    }
  }, [todos])

  const filtered = useMemo(() => {
    const t = todayIso()
    return todos.filter((x) => {
      if (filter === '全部') return x.status !== 'cancelled'
      if (filter === '进行') return x.status === 'open' || x.status === 'pending_review'
      if (filter === '今日') return (x.status === 'open' || x.status === 'pending_review') && x.due_date === t
      if (filter === '已完成') return x.status === 'done'
      return true
    })
  }, [todos, filter])

  const free = useMemo(() => filtered.filter((t) => t.kind === 'task' && t.parent_id === null), [filtered])
  const objectives = useMemo(() => filtered.filter((t) => t.kind === 'objective'), [filtered])
  const krsByParent = useMemo(() => {
    const m = new Map<string, Todo[]>()
    for (const t of filtered.filter((x) => x.kind === 'kr')) {
      const k = t.parent_id ?? ''
      const list = m.get(k) ?? []
      list.push(t)
      m.set(k, list)
    }
    for (const list of m.values()) list.sort((a, b) => a.sort_order - b.sort_order)
    return m
  }, [filtered])
  const tasksByParent = useMemo(() => {
    const m = new Map<string, Todo[]>()
    for (const t of filtered.filter((x) => x.kind === 'task' && x.parent_id)) {
      const k = t.parent_id ?? ''
      const list = m.get(k) ?? []
      list.push(t)
      m.set(k, list)
    }
    for (const list of m.values()) list.sort((a, b) => a.sort_order - b.sort_order)
    return m
  }, [filtered])

  // 焦点滚到
  useEffect(() => {
    if (!focusId) return
    const el = document.querySelector(`[data-todo-id="${focusId}"]`)
    if (el && 'scrollIntoView' in el) {
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [focusId])

  async function createObjective(): Promise<void> {
    const t: Todo = blank('objective', null, '新工作目标')
    await db.todos.add(t)
  }
  async function createKr(parent: Todo): Promise<void> {
    const t: Todo = blank('kr', parent.id, '新增 KR')
    await db.todos.add(t)
  }
  async function createTask(parent: Todo | null): Promise<void> {
    const t: Todo = blank('task', parent?.id ?? null, '新任务')
    await db.todos.add(t)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[860px] mx-auto px-6 py-8">
        {/* 顶部 */}
        <div className="flex items-end justify-between mb-4">
          <div>
            <div className="section-title">TODOS</div>
            <h1 className="text-2xl font-semibold text-text-1 mt-1">待办</h1>
          </div>
          <button onClick={() => void createObjective()} className="btn-primary text-sm h-9 px-4">
            + 新建 Objective
          </button>
        </div>

        {/* 过滤 pills */}
        <div className="flex items-center gap-1 mb-6">
          {(['全部', '进行', '今日', '已完成'] as Filter[]).map((f) => {
            const c = f === '全部' ? counts.all : f === '进行' ? counts.open : f === '今日' ? counts.today : counts.done
            const active = filter === f
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 h-7 text-xs rounded-md transition-colors ${
                  active ? 'bg-accent text-accent-contrast' : 'text-text-2 hover:bg-bg-overlay'
                }`}
              >
                {f} <span className="ml-1 text-[11px] opacity-70 tabular-nums">{c}</span>
              </button>
            )
          })}
        </div>

        {/* 自由任务 */}
        <SectionHeader
          title="自由任务"
          hint="未挂到 OKR 的任务，可拖到下方任何 Objective/KR 下。"
          onAdd={() => void createTask(null)}
          addLabel="+ 新建 Task"
        />
        {free.length === 0 ? (
          <div className="text-xs text-text-3 px-3 py-2 mb-6">无</div>
        ) : (
          <ul className="card divide-y divide-line mb-8">
            {free.map((t) => <TodoLine key={t.id} todo={t} allTodos={todos} />)}
          </ul>
        )}

        {/* Objective 树 */}
        {objectives.length === 0 && free.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="◌"
              title="还没有 Objective"
              hint="OKR 三级任务从目标开始：先建一个 Objective，再加 KR 跟，最后挂 Task。"
              action={<button onClick={() => void createObjective()} className="btn-primary h-8 text-xs">+ 新建 Objective</button>}
            />
          </div>
        ) : (
          <ul className="space-y-6">
            {objectives
              .slice()
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((o) => (
                <li key={o.id}>
                  <ObjectiveBlock
                    objective={o}
                    krs={krsByParent.get(o.id) ?? []}
                    tasksByParent={tasksByParent}
                    allTodos={todos}
                    onCreateKr={() => void createKr(o)}
                    onCreateTask={() => void createTask(o)}
                  />
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function blank(kind: TodoKind, parentId: string | null, title: string): Todo {
  const ts = now()
  return {
    id: uid(),
    kind,
    parent_id: parentId,
    title,
    notes_md: undefined,
    status: 'open',
    source: 'manual',
    sort_order: Date.now(),
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    sync_version: 0,
  }
}

// ── 子组件 ─────────────────────────────────────────────────────────
function SectionHeader({ title, hint, onAdd, addLabel }: { title: string; hint?: string; onAdd?: () => void; addLabel?: string }): JSX.Element {
  return (
    <div className="flex items-end mb-2 px-1">
      <div>
        <div className="section-title">{title}</div>
        {hint && <div className="text-[11px] text-text-3 mt-0.5">{hint}</div>}
      </div>
      {onAdd && (
        <button onClick={onAdd} className="ml-auto btn-ghost text-xs h-7 px-2">
          {addLabel ?? '+ 新建'}
        </button>
      )}
    </div>
  )
}

function ObjectiveBlock({
  objective, krs, tasksByParent, allTodos, onCreateKr, onCreateTask,
}: {
  objective: Todo
  krs: Todo[]
  tasksByParent: Map<string, Todo[]>
  allTodos: Todo[]
  onCreateKr: () => void
  onCreateTask: () => void
}): JSX.Element {
  return (
    <div data-todo-id={objective.id} className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">🏔</span>
        <span className="text-xs font-semibold tracking-wider text-text-3">OBJECTIVE</span>
        <button
          onClick={() => void db.todos.update(objective.id, { deleted_at: now(), updated_at: now() })}
          className="btn-danger text-xs h-6 ml-auto"
          title="删除 Objective（软删除）"
        >删除</button>
      </div>
      <TodoLine todo={objective} allTodos={allTodos} />
      <div className="ml-6 mt-4 space-y-3">
        {krs.length === 0 && (
          <div className="text-xs text-text-3 px-1">还没有 KR。</div>
        )}
        {krs.map((kr) => {
          const tasks = tasksByParent.get(kr.id) ?? []
          return (
            <KrBlock
              key={kr.id}
              kr={kr}
              tasks={tasks}
              allTodos={allTodos}
              onAddTask={() => {
                const t = blank('task', kr.id, '新任务')
                void db.todos.add(t)
              }}
            />
          )
        })}
        <div className="flex items-center gap-1 opacity-70 hover:opacity-100">
          <button onClick={onCreateKr} className="btn-ghost text-xs h-7">+ 新建 KR</button>
          <button onClick={onCreateTask} className="btn-ghost text-xs h-7">+ 直接挂 Task</button>
        </div>
      </div>
    </div>
  )
}

function KrBlock({
  kr, tasks, allTodos, onAddTask,
}: { kr: Todo; tasks: Todo[]; allTodos: Todo[]; onAddTask: () => void }): JSX.Element {
  return (
    <div data-todo-id={kr.id} className="border-l-2 border-line pl-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold tracking-wider text-text-3">KR</span>
      </div>
      <TodoLine todo={kr} allTodos={allTodos} />
      <ul className="ml-6 mt-1.5 space-y-0.5">
        {tasks.length === 0 && (
          <li className="text-xs text-text-3 px-1">无 Task</li>
        )}
        {tasks.map((t) => (
          <li key={t.id} data-todo-id={t.id}>
            <TodoLine todo={t} allTodos={allTodos} indent={0} />
          </li>
        ))}
        <li>
          <button
            onClick={onAddTask}
            className="opacity-70 hover:opacity-100 text-xs text-text-3 hover:text-text-1 py-0.5"
          >+ 新建 Task</button>
        </li>
      </ul>
    </div>
  )
}

function TodoLine({ todo, allTodos, indent }: { todo: Todo; allTodos: Todo[]; indent?: number }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const isDone = todo.status === 'done'
  const goMeeting = useUI((s) => s.goMeeting)
  // 会议来源：提取自会议的待办可以一键跳回（需求 #3 跟进闭环）
  const meeting = useLiveQuery(
    async () => todo.meeting_id ? await db.meetings.get(todo.meeting_id) : undefined,
    [todo.meeting_id ?? ''],
  )
  const styleFont = todo.kind === 'objective'
    ? 'text-lg font-semibold'
    : todo.kind === 'kr'
      ? 'text-[15px] font-medium'
      : 'text-sm'

  return (
    <div className={`group ${indent ? `pl-${indent}` : ''}`}>
      <div className="flex items-start gap-2 py-1.5">
        {todo.kind === 'task' ? (
          <button
            onClick={() => void db.todos.update(todo.id, {
              status: isDone ? 'open' : 'done',
              updated_at: now(),
            })}
            className={`mt-1.5 h-3.5 w-3.5 rounded border flex items-center justify-center text-[10px] ${
              isDone ? 'bg-accent border-accent text-accent-contrast' : 'border-line-strong hover:border-accent'
            }`}
            aria-label={isDone ? '取消完成' : '完成'}
          >{isDone ? '✓' : ''}</button>
        ) : (
          <span className="mt-1.5 h-3.5 w-3.5" />
        )}
        <div className="flex-1 min-w-0">
          <div
            className={`${styleFont} leading-snug ${isDone ? 'line-through text-text-3' : 'text-text-1'}`}
            onDoubleClick={() => setEditing(true)}
          >
            {todo.title}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[11px] text-text-3">
            {todo.status !== 'open' && todo.status !== 'done' && <span className="chip">{STATUS_LABELS[todo.status]}</span>}
            {todo.due_date && <span>· {todo.due_date}</span>}
            {todo.assignee && <span>· @{todo.assignee}</span>}
            {meeting && (
              <button
                onClick={() => goMeeting(meeting.id)}
                className="text-accent/80 hover:text-accent transition-colors"
                title="打开这场会议"
              >
                · ● {meeting.title}
              </button>
            )}
          </div>
        </div>
        <button
          onClick={() => setEditing((v) => !v)}
          className="opacity-0 group-hover:opacity-100 transition-opacity icon-btn !h-7 !w-7"
          aria-label="编辑"
          title="编辑"
        >⋯</button>
      </div>
      {editing && (
        <EditPopover
          todo={todo}
          allTodos={allTodos}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

function EditPopover({ todo, allTodos, onClose }: { todo: Todo; allTodos: Todo[]; onClose: () => void }): JSX.Element {
  const [title, setTitle] = useState(todo.title)
  const [due, setDue] = useState(todo.due_date ?? '')
  const [assignee, setAssignee] = useState(todo.assignee ?? '')
  const [parentId, setParentId] = useState<string>(todo.parent_id ?? '')

  async function save(): Promise<void> {
    const patch: Partial<Todo> = {
      title: title.trim() || todo.title,
      due_date: due || undefined,
      assignee: assignee.trim(),
      parent_id: parentId || null,
      updated_at: now(),
      sync_version: todo.sync_version + 1,
    }
    await db.todos.update(todo.id, patch)
    onClose()
  }

  async function remove(): Promise<void> {
    if (!window.confirm(`删除「${todo.title}」？`)) return
    await db.todos.update(todo.id, { deleted_at: now(), updated_at: now(), status: 'cancelled' })
    onClose()
  }

  // 可选的父节点：仅允许合法层级链。
  const parentOptions = useMemo(() => {
    if (todo.kind === 'objective') return [] // 顶层
    if (todo.kind === 'kr') return allTodos.filter((t) => t.kind === 'objective' && t.id !== todo.id && t.deleted_at === null)
    // task: 可挂到任何 kr，或保持 null（自由任务）
    return allTodos.filter((t) => t.kind === 'kr' && t.deleted_at === null)
  }, [todo, allTodos])

  return (
    <div className="ml-5 mb-3 mt-1 border border-line rounded-lg bg-bg-overlay p-3 space-y-3 text-sm">
      <div className="flex flex-col gap-1">
        <label className="label">标题</label>
        <input
          className="input h-8"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="label">截止日期</label>
          <input
            type="date"
            className="input h-8"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="label">负责人</label>
          <input
            className="input h-8"
            placeholder="@姓名"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          />
        </div>
      </div>

      {parentOptions.length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="label">父节点</label>
          <select
            className="input h-8"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
          >
            <option value="">（无 · 自由{todo.kind === 'kr' ? 'KR（不推荐）' : 'Task'}）</option>
            {parentOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.title}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="label">标签</label>
        <TagPicker targetType="todo" targetId={todo.id} />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button onClick={() => void save()} className="btn-primary text-xs h-8 px-3">保存</button>
        <button onClick={onClose} className="btn-ghost text-xs h-8 px-3">取消</button>
        <button onClick={() => void remove()} className="btn-danger text-xs h-8 px-3 ml-auto">删除</button>
      </div>
    </div>
  )
}