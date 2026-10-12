import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { now, today as todayIso, uid } from '../../lib/id'
import { useUI } from '../../state/ui'
import type { Todo, TodoStatus } from '../../types'
import EmptyState from '../../components/EmptyState'
import TagPicker from '../../components/TagPicker'
import {
  LEVELS, canParent, childLevels, childrenIndex, currentPeriod, inheritedScope,
  levelLabel, periodOf, periodRange, rollupProgress, shiftPeriod, subtreeIds, type Level,
} from '../../lib/okr'

type Mode = 'focus' | 'quarter' | 'strategy'

const MODES: { id: Mode; label: string }[] = [
  { id: 'focus', label: 'Focus' },
  { id: 'quarter', label: 'Quarter' },
  { id: 'strategy', label: 'Strategy' },
]

const STATUS_LABELS: Record<TodoStatus, string> = {
  open: '进行中',
  done: '已完成',
  cancelled: '已取消',
  pending_review: '待审',
}

/** 每个模式「+」菜单可建的层级 */
const MODE_LEVELS: Record<Mode, Level[]> = {
  focus: [LEVELS[6]],
  quarter: LEVELS.slice(2),
  strategy: LEVELS,
}

/** 共享给子组件的数据，避免层层传 props */
interface Ctx {
  all: Todo[]
  byId: Map<string, Todo>
  kids: Map<string | null, Todo[]>
  progress: Map<string, number>
  period: string
  tagFilter: string | null
  tagIdsByTodo: Map<string, string[]>
  setTagFilter: (id: string | null) => void
}

/**
 * OKR 页（嵌套：战略 → 季度 → 项目 → Task）。三种模式：
 *   Focus    —— 默认。Inbox + 本季度未完成 Task（+ 逾期），平铺，一键完成，无树
 *   Quarter  —— 选定季度的 季度 O → KR → 项目 O/KR → Task
 *   Strategy —— 全树；⋯ 里改父节点（规则见 lib/okr.ts），进度逐级汇总
 */
export default function TodosPage(): JSX.Element {
  const raw = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const focusId = useUI((s) => s.todoFocusId)
  const [mode, setMode] = useState<Mode>('focus')
  const [period, setPeriod] = useState(currentPeriod())
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  const allTags = useLiveQuery(() => db.tags.orderBy('name').toArray(), []) ?? []
  const todoBindings = useLiveQuery(
    () => db.tagBindings.where('target_type').equals('todo').toArray(),
    [],
  ) ?? []
  const tagIdsByTodo = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const b of todoBindings) {
      if (b.deleted_at !== null) continue
      const list = m.get(b.target_id) ?? []
      list.push(b.tag_id)
      m.set(b.target_id, list)
    }
    return m
  }, [todoBindings])
  const tagUsageCount = useMemo(() => {
    const c = new Map<string, number>()
    for (const ids of tagIdsByTodo.values()) {
      for (const id of ids) c.set(id, (c.get(id) ?? 0) + 1)
    }
    return c
  }, [tagIdsByTodo])

  const ctx: Ctx = useMemo(() => {
    const all = raw.filter((t) => t.deleted_at === null)
    return {
      all,
      byId: new Map(all.map((t) => [t.id, t])),
      kids: childrenIndex(all),
      progress: rollupProgress(all),
      period,
      tagFilter,
      tagIdsByTodo,
      setTagFilter,
    }
  }, [raw, period, tagFilter, tagIdsByTodo])

  // 外部跳转聚焦（如会议待办 → OKR）：切到 Strategy 才能看到任意层级
  useEffect(() => {
    if (!focusId) return
    const t = ctx.byId.get(focusId)
    if (t && t.parent_id) setMode('strategy')
    const id = setTimeout(() => {
      document.querySelector(`[data-todo-id="${focusId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[820px] mx-auto px-6 py-8">
        <div className="flex items-end gap-3 mb-5">
          <div>
            <div className="section-title">OKR</div>
            <h1 className="text-2xl font-semibold tracking-tight text-text-1 mt-1">目标与待办</h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div role="tablist" className="flex p-0.5 rounded-lg bg-bg-overlay border border-line">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  role="tab"
                  aria-selected={mode === m.id}
                  onClick={() => setMode(m.id)}
                  className={`px-3 h-7 text-xs rounded-md transition-colors ${
                    mode === m.id ? 'bg-bg-raise text-text-1 shadow-sm font-medium' : 'text-text-3 hover:text-text-1'
                  }`}
                >{m.label}</button>
              ))}
            </div>
            <AddMenu levels={MODE_LEVELS[mode]} ctx={ctx} />
          </div>
        </div>

        {allTags.length > 0 && todoBindings.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-5">
            <button
              onClick={() => setTagFilter(null)}
              className={`px-2.5 h-6 text-[11px] rounded-full border transition-colors ${
                tagFilter === null ? 'border-accent text-accent' : 'border-line text-text-3 hover:text-text-2 hover:border-line-strong'
              }`}
            ># 全部</button>
            {allTags
              .filter((t) => (tagUsageCount.get(t.id) ?? 0) > 0)
              .map((t) => {
                const active = tagFilter === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => setTagFilter(active ? null : t.id)}
                    className={`px-2.5 h-6 text-[11px] rounded-full border transition-colors ${
                      active ? 'border-accent bg-accent/12 text-accent' : 'border-line text-text-3 hover:text-text-2 hover:border-line-strong'
                    }`}
                    title={`${tagUsageCount.get(t.id)} 条任务`}
                  >
                    #{t.name}
                    <span className="ml-1 opacity-60 tabular-nums">{tagUsageCount.get(t.id)}</span>
                  </button>
                )
              })}
          </div>
        )}

        {mode === 'focus' && <FocusView ctx={ctx} />}
        {mode === 'quarter' && <QuarterView ctx={ctx} setPeriod={setPeriod} />}
        {mode === 'strategy' && <StrategyView ctx={ctx} />}
      </div>
    </div>
  )
}

// ── 写操作（所有新建都过 canParent）────────────────────────────────

async function createNode(level: Level, parent: Todo | null, title: string, period?: string): Promise<string> {
  if (!canParent(level, parent)) throw new Error(`${levelLabel(level)} 不能挂在 ${parent ? levelLabel(parent) : '根'} 下`)
  const ts = now()
  const id = uid()
  const t: Todo = {
    id,
    kind: level.kind,
    parent_id: parent?.id ?? null,
    scope: inheritedScope(level, parent),
    period: level.scope === 'quarterly' ? (parent?.period ?? period ?? currentPeriod()) : undefined,
    title,
    status: 'open',
    source: 'manual',
    sort_order: Date.now(),
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    sync_version: 0,
  }
  await db.todos.add(t)
  return id
}

function matchesTag(t: Todo, ctx: Ctx): boolean {
  return !ctx.tagFilter || (ctx.tagIdsByTodo.get(t.id) ?? []).includes(ctx.tagFilter)
}

// ── Focus ─────────────────────────────────────────────────────────

function FocusView({ ctx }: { ctx: Ctx }): JSX.Element {
  const t = todayIso()
  const [qStart, qEnd] = periodRange(ctx.period)
  const weekAhead = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [showDone, setShowDone] = useState(false)

  const { inbox, quarter, activeKrs, doneCount } = useMemo(() => {
    const tasks = ctx.all.filter((x) => x.kind === 'task' && matchesTag(x, ctx))
    const isOpen = (x: Todo) => x.status === 'open' || x.status === 'pending_review'
    const inbox = tasks.filter((x) => x.parent_id === null && isOpen(x))
    // 本季度：逾期 ∪ 截止在本季 ∪（无截止且未绑定其它季度）
    const quarter = tasks
      .filter((x) => x.parent_id !== null && isOpen(x))
      .filter((x) => {
        if (x.due_date) return x.due_date < t || (x.due_date >= qStart && x.due_date <= qEnd)
        const p = periodOf(x, ctx.byId)
        return p === undefined || p === ctx.period
      })
      .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
    // 本周活跃 KR：有 7 天内到期的未完成 task，或 7 天内完成过 task
    const active = new Set<string>()
    for (const x of tasks) {
      if (!x.parent_id) continue
      const hot = (isOpen(x) && x.due_date && x.due_date <= weekAhead) || (x.status === 'done' && x.updated_at >= weekAgo)
      if (hot) active.add(x.parent_id)
    }
    const activeKrs = [...active].map((id) => ctx.byId.get(id)).filter((k): k is Todo => !!k && k.kind === 'kr')
    return { inbox, quarter, activeKrs, doneCount: tasks.filter((x) => x.status === 'done').length }
  }, [ctx, t, qStart, qEnd, weekAhead, weekAgo])

  const done = showDone
    ? ctx.all.filter((x) => x.kind === 'task' && x.status === 'done' && matchesTag(x, ctx))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 30)
    : []

  return (
    <div className="space-y-6">
      {activeKrs.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {activeKrs.map((kr) => (
            <div key={kr.id} className="min-w-[180px] flex-1 max-w-[260px] rounded-lg border border-line bg-bg-raise px-3 py-2">
              <div className="text-[11px] text-text-3">{levelLabel(kr)} · 本周活跃</div>
              <div className="text-[13px] text-text-1 truncate">{kr.title}</div>
              <ProgressBar value={ctx.progress.get(kr.id) ?? 0} />
            </div>
          ))}
        </div>
      )}

      <section>
        <SectionHeader title="Inbox" hint="未挂到 KR 的任务；会议提取的待办确认后也落这里。" count={inbox.length} />
        {inbox.length === 0 ? (
          <div className="text-xs text-text-3 px-1 py-2">Inbox 清空了。</div>
        ) : (
          <ul className="card divide-y divide-line px-3">
            {inbox.map((x) => <li key={x.id} data-todo-id={x.id}><TodoLine todo={x} ctx={ctx} /></li>)}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader title={`本季度 · ${ctx.period}`} hint="挂在 KR 下、本季要推进的任务（含逾期）。" count={quarter.length} />
        {quarter.length === 0 ? (
          <div className="card">
            <EmptyState
              title="本季度没有进行中的任务"
              hint="在 Quarter / Strategy 模式里给 KR 挂 Task，它们会出现在这里。"
            />
          </div>
        ) : (
          <ul className="card divide-y divide-line px-3">
            {quarter.map((x) => <li key={x.id} data-todo-id={x.id}><TodoLine todo={x} ctx={ctx} showParent /></li>)}
          </ul>
        )}
      </section>

      {doneCount > 0 && (
        <section>
          <button onClick={() => setShowDone((v) => !v)} className="btn-ghost text-xs h-7 px-2">
            {showDone ? '隐藏' : '显示'}已完成 <span className="tabular-nums opacity-70">{doneCount}</span>
          </button>
          {showDone && (
            <ul className="card divide-y divide-line px-3 mt-2">
              {done.map((x) => <li key={x.id}><TodoLine todo={x} ctx={ctx} showParent /></li>)}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

// ── Quarter ───────────────────────────────────────────────────────

function QuarterView({ ctx, setPeriod }: { ctx: Ctx; setPeriod: (p: string) => void }): JSX.Element {
  const roots = ctx.all.filter((t) => t.kind === 'objective' && t.scope === 'quarterly' && t.period === ctx.period)
  const otherCount = ctx.all.filter((t) => t.kind === 'objective' && t.scope === 'quarterly' && t.period !== ctx.period).length
  return (
    <div>
      <div className="flex items-center gap-1 mb-4">
        <button onClick={() => setPeriod(shiftPeriod(ctx.period, -1))} className="icon-btn !h-7 !w-7" aria-label="上一季度">‹</button>
        <span className="text-sm font-medium text-text-1 tabular-nums w-20 text-center">{ctx.period}</span>
        <button onClick={() => setPeriod(shiftPeriod(ctx.period, 1))} className="icon-btn !h-7 !w-7" aria-label="下一季度">›</button>
        {ctx.period !== currentPeriod() && (
          <button onClick={() => setPeriod(currentPeriod())} className="btn-ghost text-xs h-7 px-2">回到本季</button>
        )}
        {otherCount > 0 && <span className="ml-auto text-[11px] text-text-3">其它季度 {otherCount} 个 O 已收起</span>}
      </div>
      {roots.length === 0 ? (
        <div className="card">
          <EmptyState
            title={`${ctx.period} 还没有季度目标`}
            hint="季度 O 挂在某个战略 KR 下：用右上「+」选「季度 O」，或在 Strategy 模式里从战略 KR 往下拆。"
          />
        </div>
      ) : (
        <ul className="space-y-3">
          {roots.map((o) => <li key={o.id}><OkrNode node={o} ctx={ctx} depth={0} /></li>)}
        </ul>
      )}
    </div>
  )
}

// ── Strategy ──────────────────────────────────────────────────────

function StrategyView({ ctx }: { ctx: Ctx }): JSX.Element {
  // 根 = 无父的 O/KR + 父已删除的孤儿（避免节点凭空消失）
  const roots = ctx.all.filter((t) =>
    t.kind !== 'task' ? (t.parent_id === null || !ctx.byId.has(t.parent_id))
      : (t.parent_id !== null && !ctx.byId.has(t.parent_id)),
  ).sort((a, b) => a.sort_order - b.sort_order)
  const [adding, setAdding] = useState(false)
  return (
    <div>
      {roots.length === 0 ? (
        <div className="card">
          <EmptyState
            title="还没有战略目标"
            hint="从一个年度大 O 开始，往下拆 KR → 季度 O → 项目 O → Task。"
            action={adding
              ? <InlineAdd placeholder="战略 O 标题，回车创建" onDone={() => setAdding(false)}
                  onSubmit={(title) => createNode(LEVELS[0], null, title)} />
              : <button onClick={() => setAdding(true)} className="btn-primary h-8 text-xs px-3">+ 新建战略 O</button>}
          />
        </div>
      ) : (
        <ul className="space-y-3">
          {roots.map((o) => <li key={o.id}><OkrNode node={o} ctx={ctx} depth={0} /></li>)}
        </ul>
      )}
    </div>
  )
}

// ── 树节点 ────────────────────────────────────────────────────────

function OkrNode({ node, ctx, depth }: { node: Todo; ctx: Ctx; depth: number }): JSX.Element {
  const [open, setOpen] = useState(true)
  const [adding, setAdding] = useState<Level | null>(null)
  const children = (ctx.kids.get(node.id) ?? []).filter((c) => c.kind !== 'task' || matchesTag(c, ctx))
  const options = node.kind === 'task' ? [] : childLevels(node)
  const isRoot = depth === 0

  const body = (
    <>
      <div className="flex items-start gap-1">
        {node.kind !== 'task' && (
          <button
            onClick={() => setOpen((v) => !v)}
            className={`mt-2 h-4 w-4 shrink-0 text-[10px] text-text-3 hover:text-text-1 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
            aria-label={open ? '收起' : '展开'}
          >▸</button>
        )}
        <div className="flex-1 min-w-0"><TodoLine todo={node} ctx={ctx} /></div>
      </div>
      {open && (children.length > 0 || options.length > 0) && (
        <div className="ml-5 pl-3 border-l border-line space-y-0.5">
          {children.map((c) => <div key={c.id}><OkrNode node={c} ctx={ctx} depth={depth + 1} /></div>)}
          {adding ? (
            <InlineAdd
              placeholder={`${levelLabel(adding)} 标题，回车创建`}
              onDone={() => setAdding(null)}
              onSubmit={(title) => createNode(adding, node, title)}
            />
          ) : options.length > 0 && (
            <div className="flex items-center gap-1 py-0.5">
              {options.map((l) => (
                <button
                  key={`${l.kind}:${l.scope}`}
                  onClick={() => setAdding(l)}
                  className="text-[11px] text-text-3 hover:text-accent px-1.5 h-6 rounded hover:bg-bg-overlay transition-colors"
                >+ {levelLabel(l)}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )

  return (
    <div data-todo-id={node.id} className={isRoot ? 'card px-3 py-2' : ''}>{body}</div>
  )
}

function InlineAdd({ placeholder, onSubmit, onDone }: {
  placeholder: string
  onSubmit: (title: string) => Promise<unknown>
  onDone: () => void
}): JSX.Element {
  const [v, setV] = useState('')
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="py-1">
      <input
        autoFocus
        className="input h-8 text-sm"
        placeholder={placeholder}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { if (!v.trim()) onDone() }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onDone()
          if (e.key === 'Enter' && v.trim()) {
            onSubmit(v.trim()).then(() => { setV(''); onDone() }).catch((x: unknown) => setErr(x instanceof Error ? x.message : String(x)))
          }
        }}
      />
      {err && <div className="text-[11px] text-danger mt-1">{err}</div>}
    </div>
  )
}

// ── 「+」菜单：选层级 → 选合法父节点 → 标题 ───────────────────────

function AddMenu({ levels, ctx }: { levels: Level[]; ctx: Ctx }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [level, setLevel] = useState<Level | null>(null)
  const [parentId, setParentId] = useState('')
  const [title, setTitle] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const parents = useMemo(
    () => level ? ctx.all.filter((t) => t.status !== 'cancelled' && t.status !== 'done' && canParent(level, t)) : [],
    [level, ctx.all],
  )
  const needsParent = level !== null && !canParent(level, null)

  function close(): void {
    setOpen(false); setLevel(null); setTitle(''); setParentId(''); setErr(null)
  }
  function pick(l: Level): void {
    setLevel(l)
    setErr(null)
    // 季度视图下优先预选当前季度的父节点
    const first = ctx.all.find((t) => t.status === 'open' && canParent(l, t) && (!t.period || t.period === ctx.period))
    setParentId(canParent(l, null) ? '' : first?.id ?? '')
  }
  async function submit(): Promise<void> {
    if (!level || !title.trim()) return
    try {
      await createNode(level, parentId ? ctx.byId.get(parentId) ?? null : null, title.trim(), ctx.period)
      close()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => (levels.length === 1 && !open ? (setOpen(true), pick(levels[0])) : setOpen((v) => !v))}
        className="btn-primary text-sm h-8 px-3"
      >+ 新建</button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={close} />
          <div className="absolute right-0 z-40 mt-1 w-[300px] card shadow-lg p-2 text-sm">
            {!level ? (
              <ul>
                {levels.map((l) => (
                  <li key={`${l.kind}:${l.scope}`}>
                    <button onClick={() => pick(l)} className="w-full text-left px-2.5 py-1.5 rounded-md hover:bg-bg-overlay text-text-1">
                      {levelLabel(l)}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="space-y-2 p-1">
                <div className="text-xs text-text-3">新建 {levelLabel(level)}</div>
                <input
                  autoFocus
                  className="input h-8"
                  placeholder="标题"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') close() }}
                />
                {(needsParent || parents.length > 0) && (
                  needsParent && parents.length === 0 ? (
                    <div className="text-[11px] text-warning">
                      需要先有一个可挂的父节点（{LEVELS.filter((p) => canParent(level, { kind: p.kind, scope: p.scope })).map(levelLabel).join(' / ')}）。
                    </div>
                  ) : (
                    <select className="input h-8" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                      {!needsParent && <option value="">Inbox（不挂 KR）</option>}
                      {parents.map((p) => (
                        <option key={p.id} value={p.id}>{levelLabel(p)} · {p.title}{p.period ? ` (${p.period})` : ''}</option>
                      ))}
                    </select>
                  )
                )}
                {err && <div className="text-[11px] text-danger">{err}</div>}
                <div className="flex gap-2 pt-1">
                  <button onClick={() => void submit()} disabled={!title.trim() || (needsParent && !parentId)} className="btn-primary text-xs h-7 px-3">创建</button>
                  <button onClick={close} className="btn-ghost text-xs h-7 px-3">取消</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── 行 ────────────────────────────────────────────────────────────

function SectionHeader({ title, hint, count }: { title: string; hint?: string; count?: number }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 mb-2 px-1">
      <div className="section-title">{title}</div>
      {count != null && <span className="text-[11px] text-text-3 tabular-nums">{count}</span>}
      {hint && <div className="text-[11px] text-text-3 ml-auto truncate">{hint}</div>}
    </div>
  )
}

function ProgressBar({ value }: { value: number }): JSX.Element {
  return (
    <div className="mt-1.5 h-1 rounded-full bg-bg-overlay overflow-hidden" title={`${Math.round(value * 100)}%`}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}

function TodoLine({ todo, ctx, showParent }: { todo: Todo; ctx: Ctx; showParent?: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const isDone = todo.status === 'done'
  const isTask = todo.kind === 'task'
  const goMeeting = useUI((s) => s.goMeeting)
  const goNote = useUI((s) => s.goNote)
  const meeting = useLiveQuery(
    async () => todo.meeting_id ? await db.meetings.get(todo.meeting_id) : undefined,
    [todo.meeting_id ?? ''],
  )
  const note = useLiveQuery(
    async () => todo.origin_note_id ? await db.notes.get(todo.origin_note_id) : undefined,
    [todo.origin_note_id ?? ''],
  )
  const rowTags = useLiveQuery(
    async () => {
      const bindings = await db.tagBindings.where('[target_type+target_id]').equals(['todo', todo.id]).toArray()
      const ids = bindings.filter((b) => b.deleted_at === null).map((b) => b.tag_id)
      if (ids.length === 0) return []
      return db.tags.where('id').anyOf(ids).toArray()
    },
    [todo.id],
  ) ?? []
  const parent = showParent && todo.parent_id ? ctx.byId.get(todo.parent_id) : undefined
  const progress = ctx.progress.get(todo.id) ?? 0
  const overdue = !isDone && todo.due_date && todo.due_date < todayIso()

  return (
    <div className="group">
      <div className="flex items-start gap-2.5 py-1.5">
        {isTask ? (
          <button
            onClick={() => void db.todos.update(todo.id, { status: isDone ? 'open' : 'done', updated_at: now() })}
            className={`mt-[3px] h-4 w-4 shrink-0 rounded-full border flex items-center justify-center text-[10px] transition-colors ${
              isDone ? 'bg-accent border-accent text-accent-contrast' : 'border-line-strong hover:border-accent'
            }`}
            aria-label={isDone ? '取消完成' : '完成'}
          >{isDone ? '✓' : ''}</button>
        ) : (
          <span className={`mt-[3px] shrink-0 text-[10px] font-semibold tracking-wide px-1.5 h-4 leading-4 rounded ${
            todo.kind === 'objective' ? 'bg-accent/12 text-accent' : 'bg-bg-overlay text-text-2'
          }`}>{levelLabel(todo)}</span>
        )}
        <div className="flex-1 min-w-0">
          <div
            className={`leading-snug ${todo.kind === 'objective' ? 'text-[15px] font-semibold' : todo.kind === 'kr' ? 'text-sm font-medium' : 'text-sm'} ${
              isDone ? 'line-through text-text-3' : 'text-text-1'
            }`}
            onDoubleClick={() => setEditing(true)}
          >{todo.title}</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-text-3 empty:hidden">
            {todo.status !== 'open' && todo.status !== 'done' && <span className="chip !py-0">{STATUS_LABELS[todo.status]}</span>}
            {todo.period && todo.kind === 'objective' && <span>{todo.period}</span>}
            {parent && <span className="truncate max-w-[24ch]">↳ {parent.title}</span>}
            {todo.due_date && <span className={overdue ? 'text-danger' : ''}>{todo.due_date}</span>}
            {todo.assignee && <span>@{todo.assignee}</span>}
            {meeting && (
              <button onClick={() => goMeeting(meeting.id)} className="text-accent/80 hover:text-accent" title="打开这场会议">
                会议 · {meeting.title}
              </button>
            )}
            {note && (
              <button onClick={() => goNote(note.id)} className="text-accent/80 hover:text-accent" title="打开这篇笔记">
                笔记 · {note.title || '未命名笔记'}
              </button>
            )}
            {rowTags.map((tag) => (
              <button key={tag.id} onClick={() => ctx.setTagFilter(tag.id)} className="text-accent/70 hover:text-accent" title={`按 #${tag.name} 过滤`}>
                #{tag.name}
              </button>
            ))}
          </div>
          {!isTask && (ctx.kids.get(todo.id)?.length ?? 0) > 0 && <ProgressBar value={progress} />}
        </div>
        {!isTask && (ctx.kids.get(todo.id)?.length ?? 0) > 0 && (
          <span className="mt-[3px] text-[11px] text-text-3 tabular-nums">{Math.round(progress * 100)}%</span>
        )}
        <button
          onClick={() => setEditing((v) => !v)}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity icon-btn !h-7 !w-7"
          aria-label="编辑"
          title="编辑"
        >⋯</button>
      </div>
      {editing && <EditPopover todo={todo} ctx={ctx} onClose={() => setEditing(false)} />}
    </div>
  )
}

function EditPopover({ todo, ctx, onClose }: { todo: Todo; ctx: Ctx; onClose: () => void }): JSX.Element {
  const [title, setTitle] = useState(todo.title)
  const [due, setDue] = useState(todo.due_date ?? '')
  const [assignee, setAssignee] = useState(todo.assignee ?? '')
  const [parentId, setParentId] = useState<string>(todo.parent_id ?? '')
  const [period, setPeriod] = useState(todo.period ?? '')
  const [weight, setWeight] = useState(todo.weight != null ? String(todo.weight) : '')
  const [err, setErr] = useState<string | null>(null)

  const level: Level = { kind: todo.kind, scope: todo.kind === 'task' ? null : todo.scope }
  const parentOptions = useMemo(() => {
    const own = subtreeIds(todo.id, ctx.all)
    return ctx.all.filter((t) => !own.has(t.id) && t.status !== 'cancelled' && canParent(level, t))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todo.id, ctx.all])
  const rootOk = canParent(level, null)
  const parentWeighted = todo.parent_id !== null

  async function save(): Promise<void> {
    const parent = parentId ? ctx.byId.get(parentId) ?? null : null
    if (!canParent(level, parent)) {
      setErr(`${levelLabel(level)} 不能挂在 ${parent ? levelLabel(parent) : '根'} 下`)
      return
    }
    if (todo.scope === 'quarterly' && !/^\d{4}-Q[1-4]$/.test(period)) {
      setErr('季度节点需要 period，格式如 2026-Q4')
      return
    }
    const w = weight.trim() === '' ? undefined : Number(weight)
    if (w !== undefined && !(w >= 0 && w <= 1)) {
      setErr('权重需在 0–1 之间')
      return
    }
    await db.todos.update(todo.id, {
      title: title.trim() || todo.title,
      due_date: due || undefined,
      assignee: assignee.trim(),
      parent_id: parent?.id ?? null,
      scope: inheritedScope(level, parent),
      period: todo.scope === 'quarterly' ? period : todo.period,
      weight: w,
      updated_at: now(),
      sync_version: todo.sync_version + 1,
    })
    onClose()
  }

  async function remove(): Promise<void> {
    const ids = [...subtreeIds(todo.id, ctx.all)]
    const extra = ids.length - 1
    if (!window.confirm(`删除「${todo.title}」${extra > 0 ? `及其下 ${extra} 项` : ''}？`)) return
    const ts = now()
    await db.transaction('rw', db.todos, db.tagBindings, async () => {
      for (const id of ids) {
        await db.todos.update(id, { deleted_at: ts, updated_at: ts, status: 'cancelled' })
      }
      // 同步软删除 tagBindings —— 否则 tag 计数虚高
      const bindings = await db.tagBindings
        .where('target_type').equals('todo')
        .and((b) => ids.includes(b.target_id) && b.deleted_at === null)
        .toArray()
      for (const b of bindings) {
        await db.tagBindings.update(b.id, { deleted_at: ts, updated_at: ts })
      }
    })
    onClose()
  }

  return (
    <div className="ml-6 mb-3 mt-1 rounded-xl border border-line bg-bg-overlay p-3 space-y-3 text-sm">
      <div className="flex flex-col gap-1">
        <label className="label">标题 · {levelLabel(level)}</label>
        <input className="input h-8" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="label">截止日期</label>
          <input type="date" className="input h-8" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="label">负责人</label>
          <input className="input h-8" placeholder="@姓名" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
        </div>
        {todo.scope === 'quarterly' && todo.kind !== 'task' && (
          <div className="flex flex-col gap-1">
            <label className="label">季度</label>
            <input className="input h-8" placeholder="2026-Q4" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </div>
        )}
        {parentWeighted && (
          <div className="flex flex-col gap-1">
            <label className="label">汇总权重（0–1，默认 1）</label>
            <input className="input h-8" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
          </div>
        )}
      </div>

      {(parentOptions.length > 0 || !rootOk) && (
        <div className="flex flex-col gap-1">
          <label className="label">父节点</label>
          <select className="input h-8" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            {rootOk && <option value="">{todo.kind === 'task' ? 'Inbox（不挂 KR）' : '（根）'}</option>}
            {!rootOk && !parentId && <option value="">（请选择）</option>}
            {parentOptions.map((o) => (
              <option key={o.id} value={o.id}>{levelLabel(o)} · {o.title}{o.period ? ` (${o.period})` : ''}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="label">标签</label>
        <TagPicker targetType="todo" targetId={todo.id} />
      </div>

      {err && <div className="text-[11px] text-danger">{err}</div>}
      <div className="flex items-center gap-2 pt-1">
        <button onClick={() => void save()} className="btn-primary text-xs h-8 px-3">保存</button>
        <button onClick={onClose} className="btn-ghost text-xs h-8 px-3">取消</button>
        <button onClick={() => void remove()} className="btn-danger text-xs h-8 px-3 ml-auto">删除</button>
      </div>
    </div>
  )
}
