import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { now, today as todayIso, uid } from '../../lib/id'
import { useUI } from '../../state/ui'
import type { Todo, TodoStatus } from '../../types'
import EmptyState from '../../components/EmptyState'
import TagPicker from '../../components/TagPicker'
import TaskModeSwitch from '../../components/TaskModeSwitch'
import QuickAddBar from '../../components/QuickAddBar'
import { attachTask } from '../../lib/todoActions'
import { dropPlan, levelOf, nudge, pathOf, reparent, validParents, type Patch } from '../../lib/okrMove'
import {
  LEVELS, canParent, childLevels, childrenIndex, currentPeriod, inheritedScope,
  levelLabel, periodOf, periodRange, rollupProgress, shiftPeriod, subtreeIds, suggestKr, type Level,
} from '../../lib/okr'

type Mode = 'focus' | 'quarter' | 'strategy'

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
  /** 每个节点的深度（根=0）：缩进投影用 */
  depth: Map<string, number>
  period: string
  tagFilter: string | null
  tagIdsByTodo: Map<string, string[]>
  setTagFilter: (id: string | null) => void
}

/**
 * OKR 页（嵌套：战略 → 季度 → 项目 → Task）。三种模式：
 *   Focus    —— 默认。Inbox + 本季度未完成 Task（+ 逾期），平铺，一键完成，无树
 *   Quarter  —— 选定季度的 季度 O → KR → 项目 O/KR → Task
 *   Strategy —— 全树；拖拽 / ⋯「移动到…」换位置（规则见 lib/okrMove.ts），进度逐级汇总
 */
export default function TodosPage(): JSX.Element {
  const raw = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const focusId = useUI((s) => s.todoFocusId)
  const mode = useUI((s) => s.taskMode)
  const setMode = (m: Mode): void => useUI.setState({ taskMode: m })
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
    const kids = childrenIndex(all)
    const depth = new Map<string, number>()
    const walk = (id: string | null, d: number, seen: Set<string>): void => {
      for (const k of kids.get(id) ?? []) {
        if (seen.has(k.id)) continue
        seen.add(k.id)
        depth.set(k.id, d)
        walk(k.id, d + 1, seen)
      }
    }
    walk(null, 0, new Set())
    return {
      all,
      byId: new Map(all.map((t) => [t.id, t])),
      kids,
      depth,
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
        <div className="flex flex-wrap items-end gap-3 mb-5">
          <div>
            <div className="section-title">任务 · OKR</div>
            <h1 className="text-2xl font-semibold tracking-tight text-text-1 mt-1">目标与待办</h1>
          </div>
          {/* 手机上单独占一行：视角切换可横滑，「新建」不换行 */}
          <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-2 min-w-0">
            <div className="flex-1 min-w-0 sm:flex-none"><TaskModeSwitch /></div>
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
      <QuickAddBar />
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
              hint="在「本季 OKR」/「战略」视图里给 KR 挂 Task，它们会出现在这里。"
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
      <TreeDnd ctx={ctx}>
        <InboxStrip ctx={ctx} />
        {roots.length === 0 ? (
          <div className="card">
            <EmptyState
              title={`${ctx.period} 还没有季度目标`}
              hint="季度 O 挂在某个战略 KR 下：用右上「+ 新建」选「季度 O」，或在「战略」视图里从战略 KR 的 ＋ 往下拆。"
            />
          </div>
        ) : (
          <ul className="space-y-3">
            {roots.map((o) => <li key={o.id}><OkrNode node={o} ctx={ctx} depth={0} /></li>)}
          </ul>
        )}
      </TreeDnd>
    </div>
  )
}

// ── Strategy ──────────────────────────────────────────────────────

/** 战略视图：一个战略 O 一个 tab，只看自己这棵树，层次更清楚；不属于任何战略 O 的根进「其它」 */
function StrategyView({ ctx }: { ctx: Ctx }): JSX.Element {
  // 根 = 无父的 O/KR + 父已删除的孤儿（避免节点凭空消失）
  const roots = ctx.all.filter((t) =>
    t.kind !== 'task' ? (t.parent_id === null || !ctx.byId.has(t.parent_id))
      : (t.parent_id !== null && !ctx.byId.has(t.parent_id)),
  ).sort((a, b) => a.sort_order - b.sort_order)
  const [adding, setAdding] = useState(false)

  const tabOs = ctx.all
    .filter((t) => t.kind === 'objective' && t.scope === 'strategic' && t.parent_id === null)
    .sort((a, b) => a.sort_order - b.sort_order)
  const tabIds = new Set(tabOs.map((o) => o.id))
  const otherRoots = roots.filter((r) => !tabIds.has(r.id))
  const tabs = [
    ...tabOs.map((o) => ({ id: o.id, title: o.title })),
    ...(otherRoots.length > 0 ? [{ id: '__other', title: '其它' }] : []),
  ]

  const okrTabId = useUI((s) => s.okrTabId)
  const setOkrTab = useUI((s) => s.setOkrTab)
  const active = tabs.some((t) => t.id === okrTabId) ? okrTabId! : (tabs[0]?.id ?? null)

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
        <>
          {tabs.length > 1 && (
            <div className="flex gap-0.5 overflow-x-auto border-b border-line mb-4 px-1">
              {tabs.map((t) => {
                const isActive = t.id === active
                const pct = t.id !== '__other' ? ctx.progress.get(t.id) : undefined
                return (
                  <button
                    key={t.id}
                    onClick={() => setOkrTab(t.id)}
                    className={`shrink-0 px-3 h-9 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${
                      isActive ? 'border-accent text-accent font-medium' : 'border-transparent text-text-3 hover:text-text-1'
                    }`}
                    aria-selected={isActive}
                    role="tab"
                  >
                    {t.title || '未命名 O'}
                    {pct != null && pct > 0 && (
                      <span className={`ml-1.5 text-[10px] tabular-nums ${isActive ? 'opacity-80' : 'opacity-60'}`}>
                        {Math.round(pct * 100)}%
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          <TreeDnd ctx={ctx}>
            <InboxStrip ctx={ctx} />
            {tabOs.map((o) => (
              <div key={o.id} className={o.id === active ? '' : 'hidden'} role="tabpanel">
                <ul className="space-y-3">
                  <li><OkrNode node={o} ctx={ctx} depth={0} /></li>
                </ul>
              </div>
            ))}
            {otherRoots.length > 0 && (
              <div className={active === '__other' ? '' : 'hidden'} role="tabpanel">
                <ul className="space-y-3">
                  {otherRoots.map((o) => <li key={o.id}><OkrNode node={o} ctx={ctx} depth={0} /></li>)}
                </ul>
              </div>
            )}
          </TreeDnd>
        </>
      )}
    </div>
  )
}

// ── 树节点 ────────────────────────────────────────────────────────

function OkrNode({ node, ctx, depth }: { node: Todo; ctx: Ctx; depth: number }): JSX.Element {
  const open = useOpen((s) => s.map[node.id] ?? true)
  const [adding, setAdding] = useState<Level | null>(null)
  const children = [...(ctx.kids.get(node.id) ?? [])]
    .filter((c) => c.kind !== 'task' || matchesTag(c, ctx))
    .sort((x, y) => x.sort_order - y.sort_order)
  const options = childLevels(node)
  const isRoot = depth === 0
  // 指示线只订阅自己这一行，拖动时不会全树重渲染
  const indicator = useDrag((s) => (s.overId === node.id ? s.zone : null))
  const indicatorLevel = useDrag((s) => (s.overId === node.id ? s.level : 0))
  const dragging = useDrag((s) => s.activeId === node.id)
  const { setNodeRef: setDragRef, setActivatorNodeRef, listeners, attributes } = useDraggable({ id: node.id })

  const startAdd = (l: Level): void => { setNodeOpen(node.id, true); setAdding(l) }

  return (
    <div data-todo-id={node.id} className={isRoot ? 'card px-2 md:px-3 py-1.5' : ''}>
      <div
        ref={setDragRef}
        className={`group/row relative flex items-start rounded-md transition-colors ${
          indicator === 'inside' ? 'ring-2 ring-accent/50 bg-accent/8' : ''
        } ${dragging ? 'opacity-40' : ''}`}
      >
        {indicator === 'before' && <DropLine className="-top-px" inset={indicatorLevel * indentPx()} />}
        {indicator === 'after' && <DropLine className="-bottom-px" inset={indicatorLevel * indentPx()} />}
        {/* 拖拽手柄：只从手柄起拖，不抢正文的文本选择和双击编辑 */}
        <button
          ref={setActivatorNodeRef}
          {...listeners}
          {...attributes}
          className="mt-1 h-6 w-4 shrink-0 flex items-center justify-center text-[10px] text-text-3 hover:text-text-1 cursor-grab active:cursor-grabbing touch-none opacity-100 md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100 transition-opacity"
          aria-label="拖动调整位置"
          title="拖动调整位置"
        >⠿</button>
        {node.kind !== 'task' ? (
          <button
            onClick={() => setNodeOpen(node.id, !open)}
            className="mt-1 h-6 w-5 shrink-0 flex items-center justify-center text-[11px] text-text-3 hover:text-text-1"
            aria-label={open ? '收起' : '展开'}
            aria-expanded={open}
          ><span className={`inline-block transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>▸</span></button>
        ) : <span className="w-5 shrink-0" />}
        <div className="flex-1 min-w-0"><TodoLine todo={node} ctx={ctx} addOptions={options} onAdd={startAdd} /></div>
      </div>
      {open && (children.length > 0 || adding) && (
        <div className="ml-2.5 md:ml-4 pl-1.5 md:pl-3 border-l border-line">
          {children.map((c) => <OkrNode key={c.id} node={c} ctx={ctx} depth={depth + 1} />)}
          {adding && (
            <div className="pl-6">
              <InlineAdd
                placeholder={`${levelLabel(adding)} 标题，回车创建`}
                onDone={() => setAdding(null)}
                onSubmit={(title) => createNode(adding, node, title)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 每层缩进的实际像素（与「ml-2.5 md:ml-4 pl-1.5 md:pl-3」对应）：桌面 16+12，移动 10+6 */
function indentPx(): number {
  return window.innerWidth >= 768 ? 28 : 16
}

/** 落点指示线：accent 圆点 + 横线（Notion 风格）；inset>0 时左移 = 投影到更浅层级 */
function DropLine({ className, inset = 0 }: { className: string; inset?: number }): JSX.Element {
  return (
    <div
      className={`pointer-events-none absolute right-0 z-10 flex items-center ${className}`}
      style={{ left: -inset }}
    >
      <div className="h-[5px] w-[5px] shrink-0 rounded-full bg-accent" />
      <div className="h-[2px] flex-1 rounded-full bg-accent" />
    </div>
  )
}

/** 拖拽落点 → 补丁：inbox 特例 = 移出 KR 回 Inbox；其余走 lib/okrMove 的规则校验 */
function planAt(ctx: Ctx, draggedId: string, overId: string, zone: DropZone): Patch[] | null {
  const dragged = ctx.byId.get(draggedId)
  if (!dragged) return null
  if (overId === 'inbox') {
    if (dragged.kind !== 'task' || dragged.parent_id === null) return null
    const r = reparent(dragged, null, ctx.all)
    return 'error' in r ? null : [r]
  }
  const target = ctx.byId.get(overId)
  if (!target || dragged.id === target.id) return null
  const plan = dropPlan(dragged, target, zone, ctx.all)
  return 'error' in plan ? null : plan
}

/**
 * 树拖拽上下文。dnd-kit 负责：跟随指针的拖影（DragOverlay）、划过滚动容器边缘时
 * 自动滚动、指针传感器（6px 死区，误触不触发）。落点判定自己跟 pointer：
 * elementFromPoint 命中行 → 三区规则 → okrMove 校验，非法落点不显示指示线，
 * rAF 节流一帧一次；合成事件和真实鼠标走同一条路径。
 * 悬停折叠节点 500ms 自动展开。
 * ponytail: 固定三区命中，不做多级投影（grandparent/indent 感知）；树要更像 Notion 时再上 sortable。
 */
function TreeDnd({ ctx, children }: { ctx: Ctx; children: React.ReactNode }): JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeTodo = useDrag((s) => (s.activeId ? ctx.byId.get(s.activeId) : undefined))

  // 命中检测：指针下的有效落点，O(1)。返回 null = 指针下没有可放置处（拖动继续，只是无指示）。
  // 缩进投影（Notion 式）：排序区里指针靠左一个缩进条带 = 目标上溯一级父节点，
  // 指示线随之左移；非法层级的投影自动向浅回退，全非法才不给指示。
  // ponytail: 行内最多投影一级（更深的左移会落到祖先行的间隙区，见 hitAt 的间隙拒识），
  // 更深的挪动可以拖到父行上完成；要任意级投影得让行占满整宽再改。
  function hitAt(x: number, y: number): { id: string; zone: DropZone; level: number } | null {
    const activeId = useDrag.getState().activeId
    if (!activeId) return null
    const el = document.elementFromPoint(x, y)
    if (el?.closest('[data-drop="inbox"]')) {
      return planAt(ctx, activeId, 'inbox', 'inside') ? { id: 'inbox', zone: 'inside', level: 0 } : null
    }
    const hit = el?.closest('[data-todo-id]') as HTMLElement | null
    const id = hit?.dataset.todoId
    if (!id) return null
    const rowEl = hit.querySelector(':scope > div')
    if (!rowEl) return null
    const r = rowEl.getBoundingClientRect()
    if (y < r.top - 4 || y > r.bottom + 4) return null // 行间隙：等下一次采样，避免抖动
    const t = ctx.byId.get(id)
    if (!t) return null
    const fy = (y - r.top) / r.height
    // 所有节点统一三区：上/下 1/4 排序，中间挂进来（task 也能挂 task = 大任务拆小任务）
    const zone: DropZone = fy < 0.25 ? 'before' : fy > 0.75 ? 'after' : 'inside'
    if (zone === 'inside') {
      return planAt(ctx, activeId, id, 'inside') ? { id, zone, level: 0 } : null
    }
    const depth = ctx.depth.get(id) ?? 0
    const k = Math.min(Math.max(Math.ceil((r.left + indentPx() / 2 - x) / indentPx()), 0), Math.min(depth, 1))
    for (let kk = k; kk >= 0; kk--) {
      if (resolveDrop(ctx, activeId, id, zone, kk)) return { id, zone, level: kk }
    }
    return null
  }

  /** 按投影层级解析最终补丁：level>0 = 目标上溯 level 级父节点后再排前/后 */
  function resolveDrop(ctx: Ctx, activeId: string, hoverId: string, zone: DropZone, level: number): Patch[] | null {
    if (zone === 'inside') return planAt(ctx, activeId, hoverId, 'inside')
    let eff = ctx.byId.get(hoverId)
    for (let i = 0; i < level && eff; i++) {
      eff = eff.parent_id ? ctx.byId.get(eff.parent_id) : undefined
    }
    if (!eff) return null
    return planAt(ctx, activeId, eff.id, zone)
  }

  function clearExpand(): void {
    if (expandTimer.current) { clearTimeout(expandTimer.current); expandTimer.current = null }
  }
  function reset(): void {
    clearExpand()
    document.removeEventListener('pointermove', onPointerMove)
    useDrag.setState({ activeId: null, overId: null, zone: null, level: 0 })
  }

  // 拖动期间自己跟 pointer（不用 dnd-kit 的 over 事件）：elementFromPoint 命中 + rAF 节流，
  // 指示线更新一帧一次，合成事件和真实鼠标走同一条路径。
  const rafId = useRef(0)
  const pendingPos = useRef<{ x: number; y: number } | null>(null)
  function onPointerMove(e: PointerEvent): void {
    pendingPos.current = { x: e.clientX, y: e.clientY }
    if (rafId.current) return
    rafId.current = requestAnimationFrame(() => {
      rafId.current = 0
      const p = pendingPos.current
      if (!p) return
      clearExpand()
      const hit = hitAt(p.x, p.y)
      const cur = useDrag.getState()
      if (!hit) {
        if (cur.overId) useDrag.setState({ overId: null, zone: null, level: 0 })
        return
      }
      if (cur.overId !== hit.id || cur.zone !== hit.zone || cur.level !== hit.level) {
        useDrag.setState({ overId: hit.id, zone: hit.zone, level: hit.level })
      }
      // 悬停折叠节点 → 500ms 自动展开
      if (hit.zone === 'inside' && useOpen.getState().map[hit.id] === false) {
        expandTimer.current = setTimeout(() => setNodeOpen(hit.id, true), 500)
      }
    })
  }

  function onDragStart(e: DragStartEvent): void {
    useDrag.setState({ activeId: String(e.active.id), overId: null, zone: null, level: 0 })
    document.addEventListener('pointermove', onPointerMove)
  }

  function onDragEnd(): void {
    const { activeId, overId, zone, level } = useDrag.getState()
    reset()
    if (!activeId || !overId || !zone) return
    const plan = zone === 'inside' || overId === 'inbox'
      ? planAt(ctx, activeId, overId, zone)
      : resolveDrop(ctx, activeId, overId, zone, level)
    if (plan) void applyPatches(plan, ctx.all).then(() => {
      if (zone === 'inside' && overId !== 'inbox') setNodeOpen(overId, true)
    })
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={reset}>
      {children}
      <DragOverlay dropAnimation={null} className="pointer-events-none">
        {activeTodo ? (
          /* 拖影偏在指针左上方，落点指示线在指针下才看得见（Notion 同款处理） */
          <div className="card pointer-events-none max-w-[420px] -translate-x-[10%] -translate-y-[140%] rotate-[1.5deg] truncate px-3 py-2 text-sm text-text-1 shadow-xl">
            {activeTodo.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

/** Inbox（未挂 KR 的任务）放在树视图顶部：拖到 KR 上归位；树里的任务拖回这里 = 取消挂载。
 *  始终渲染（哪怕空）——否则拖动已挂载任务时它突然出现，会把整棵树顶下去一截。 */
function InboxStrip({ ctx }: { ctx: Ctx }): JSX.Element {
  const inbox = ctx.all
    .filter((t) => t.kind === 'task' && t.parent_id === null && (t.status === 'open' || t.status === 'pending_review') && matchesTag(t, ctx))
    .sort((a, b) => a.sort_order - b.sort_order)
  const draggingId = useDrag((st) => st.activeId)
  const over = useDrag((st) => st.overId === 'inbox')
  const dragged = draggingId ? ctx.byId.get(draggingId) : undefined
  const canDrop = !!dragged && dragged.kind === 'task' && dragged.parent_id !== null
  return (
    <section
      data-drop="inbox"
      className={`card px-2 md:px-3 py-2 mb-3 transition-colors ${over ? 'ring-2 ring-accent/50 bg-accent/8' : ''}`}
    >
      <div className="flex items-baseline gap-2 px-1 mb-1">
        <span className="section-title">Inbox</span>
        <span className="text-[11px] text-text-3 tabular-nums">{inbox.length}</span>
        <span className="text-[11px] text-text-3 ml-auto hidden sm:inline">拖到下面的 KR 上即可归位 · 或用 ⋯ →「移动到…」</span>
      </div>
      {inbox.length > 0
        ? inbox.map((t) => <OkrNode key={t.id} node={t} ctx={ctx} depth={1} />)
        : canDrop && <p className="text-[12px] text-text-3 px-1 py-1">放到这里 = 移出 KR，回到 Inbox</p>}
    </section>
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
        className="btn-primary text-sm h-8 px-3 whitespace-nowrap shrink-0"
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

function TodoLine({ todo, ctx, showParent, addOptions = [], onAdd }: {
  todo: Todo
  ctx: Ctx
  showParent?: boolean
  /** 树视图里：可新增的子层级（＋ 按钮） */
  addOptions?: Level[]
  onAdd?: (l: Level) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(false)
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
  const hasKids = (ctx.kids.get(todo.id) ?? []).some((t) => t.deleted_at === null)
  const showProgress = !isTask || hasKids
  // Inbox 任务：给出一个建议 KR，一键挂上（不用打开编辑表单选父节点）
  const suggested = useMemo(
    () => isTask && todo.parent_id === null && !isDone ? suggestKr(todo.title, ctx.all) : null,
    [isTask, isDone, todo.parent_id, todo.title, ctx.all],
  )
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
            {suggested && (
              <button
                onClick={() => void attachTask(todo, suggested)}
                className="px-1.5 rounded border border-dashed border-accent/40 text-accent/80 hover:text-accent hover:bg-accent/8"
                title="一键挂到这个 KR"
              >→ 挂到 {levelLabel(suggested)} · {suggested.title}</button>
            )}
            {rowTags.map((tag) => (
              <button key={tag.id} onClick={() => ctx.setTagFilter(tag.id)} className="text-accent/70 hover:text-accent" title={`按 #${tag.name} 过滤`}>
                #{tag.name}
              </button>
            ))}
          </div>
          {showProgress && progress > 0 && <ProgressBar value={progress} />}
        </div>
        {showProgress && progress > 0 && (
          <span className="mt-[3px] text-[11px] text-text-3 tabular-nums shrink-0">{Math.round(progress * 100)}%</span>
        )}
        {/* 行操作：桌面悬停出现，触屏常驻 */}
        <div className="flex items-center shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity">
          {onAdd && addOptions.length > 0 && (
            <RowMenu
              label="＋"
              title="新增下级"
              items={addOptions.map((l) => ({ label: `新增${levelLabel(l)}`, run: () => onAdd(l) }))}
            />
          )}
          <RowMenu
            label="⋯"
            title="更多操作"
            items={[
              { label: '编辑', run: () => setEditing(true) },
              { label: '移动到…', run: () => setMoving(true) },
              { label: '上移', run: () => void applyPatches(nudge(siblingsOf(todo, ctx), todo.id, -1), ctx.all) },
              { label: '下移', run: () => void applyPatches(nudge(siblingsOf(todo, ctx), todo.id, 1), ctx.all) },
              { label: '删除', danger: true, run: () => void removeNode(todo, ctx.all) },
            ]}
          />
        </div>
      </div>
      {editing && <EditPopover todo={todo} ctx={ctx} onClose={() => setEditing(false)} />}
      {moving && <MovePicker todo={todo} ctx={ctx} onClose={() => setMoving(false)} />}
    </div>
  )
}

function EditPopover({ todo, ctx, onClose }: { todo: Todo; ctx: Ctx; onClose: () => void }): JSX.Element {
  const [title, setTitle] = useState(todo.title)
  const [due, setDue] = useState(todo.due_date ?? '')
  const [assignee, setAssignee] = useState(todo.assignee ?? '')
  const [period, setPeriod] = useState(todo.period ?? '')
  const [weight, setWeight] = useState(todo.weight != null ? String(todo.weight) : '')
  const [err, setErr] = useState<string | null>(null)
  const level = levelOf(todo)

  async function save(): Promise<void> {
    if (todo.scope === 'quarterly' && todo.kind !== 'task' && !/^\d{4}-Q[1-4]$/.test(period)) {
      setErr('季度格式如 2026-Q4')
      return
    }
    const w = weight.trim() === '' ? undefined : Number(weight)
    if (w !== undefined && !(w >= 0 && w <= 1)) {
      setErr('占比需在 0–1 之间（如 0.5 表示占一半）')
      return
    }
    await db.todos.update(todo.id, {
      title: title.trim() || todo.title,
      due_date: due || undefined,
      assignee: assignee.trim(),
      period: todo.scope === 'quarterly' && todo.kind !== 'task' ? period : todo.period,
      weight: w,
      updated_at: now(),
      sync_version: todo.sync_version + 1,
    })
    onClose()
  }

  return (
    <div
      className="ml-0 md:ml-6 mb-3 mt-1 rounded-xl border border-line bg-bg-overlay p-3 space-y-3 text-sm"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save() }}
    >
      <div className="flex flex-col gap-1">
        <label className="label">标题 · {levelLabel(level)}</label>
        <input className="input h-8" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save() }} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="label">截止日期</label>
          <input type="date" className="input h-8" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="label">负责人</label>
          <input className="input h-8" placeholder="姓名" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
        </div>
        {todo.scope === 'quarterly' && todo.kind !== 'task' && (
          <div className="flex flex-col gap-1">
            <label className="label">季度</label>
            <input className="input h-8" placeholder="2026-Q4" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </div>
        )}
      </div>

      <div>
        <label className="label">标签</label>
        <TagPicker targetType="todo" targetId={todo.id} />
      </div>

      {todo.parent_id !== null && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-text-3">高级</summary>
          <div className="flex flex-col gap-1 mt-2 max-w-[240px]">
            <label className="label">在上级进度中的占比（0–1，默认 1）</label>
            <input className="input h-8" inputMode="decimal" placeholder="1" value={weight} onChange={(e) => setWeight(e.target.value)} />
          </div>
        </details>
      )}

      {err && <div className="text-[11px] text-danger">{err}</div>}
      <div className="flex items-center gap-2 pt-1">
        <button onClick={() => void save()} className="btn-primary text-xs h-8 px-3">保存</button>
        <button onClick={onClose} className="btn-ghost text-xs h-8 px-3">取消</button>
        <span className="text-[11px] text-text-3 ml-auto hidden sm:inline">换位置：⋯ →「移动到…」或直接拖动</span>
      </div>
    </div>
  )
}

// ── 移动 / 排序 / 删除（所有写操作走 lib/okrMove 校验）───────────────────

type DropZone = 'before' | 'after' | 'inside'

/** 正在拖动的节点 + 当前落点 + 缩进投影层级；行组件各自订阅自己的指示线，拖动时不会全树重渲染 */
const useDrag = create<{ activeId: string | null; overId: string | null; zone: DropZone | null; level: number }>(
  () => ({ activeId: null, overId: null, zone: null, level: 0 }),
)

/** 折叠状态提升到 store：拖拽悬停自动展开需要能改它；缺省 = 展开 */
const useOpen = create<{ map: Record<string, boolean> }>(() => ({ map: {} }))
const setNodeOpen = (id: string, open: boolean): void => {
  useOpen.setState((s) => ({ map: { ...s.map, [id]: open } }))
}

async function applyPatches(patches: Patch[], all: Todo[]): Promise<void> {
  if (patches.length === 0) return
  const ts = now()
  await db.transaction('rw', db.todos, async () => {
    for (const p of patches) {
      const cur = all.find((t) => t.id === p.id)
      await db.todos.update(p.id, { ...p.changes, updated_at: ts, sync_version: (cur?.sync_version ?? 0) + 1 })
    }
  })
}

function siblingsOf(todo: Todo, ctx: Ctx): Todo[] {
  return (ctx.kids.get(todo.parent_id) ?? []).filter((t) => t.deleted_at === null && (todo.kind === 'task') === (t.kind === 'task'))
}

async function removeNode(todo: Todo, all: Todo[]): Promise<void> {
  const ids = [...subtreeIds(todo.id, all)]
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
}

/** 小下拉菜单（＋ 新增下级 / ⋯ 更多） */
function RowMenu({ label, title, items }: {
  label: string
  title: string
  items: { label: string; run: () => void; danger?: boolean }[]
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        className="icon-btn !h-7 !w-7 text-[13px]"
        aria-label={title}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >{label}</button>
      {open && (
        <>
          {/* 菜单要压过右下角的引导卡片等浮层（z-40） */}
          <div className="fixed inset-0 z-[44]" onClick={() => setOpen(false)} />
          <ul role="menu" className="absolute right-0 z-[45] mt-1 min-w-[132px] card p-1 shadow-lg text-[13px]">
            {items.map((it) => (
              <li key={it.label}>
                <button
                  role="menuitem"
                  onClick={() => { setOpen(false); it.run() }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-md hover:bg-bg-overlay ${it.danger ? 'text-danger' : 'text-text-1'}`}
                >{it.label}</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** 「移动到…」：只列合法的目标（带完整路径），可搜索、键盘上下选、回车确认 */
function MovePicker({ todo, ctx, onClose }: { todo: Todo; ctx: Ctx; onClose: () => void }): JSX.Element {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const { parents, rootOk } = useMemo(() => validParents(todo, ctx.all), [todo, ctx.all])
  const options = useMemo(() => {
    const rows: { id: string | null; title: string; badge: string; path: string }[] = []
    if (rootOk) rows.push({ id: null, title: todo.kind === 'task' ? 'Inbox（不挂 KR）' : '最外层', badge: '', path: '' })
    for (const p of parents) rows.push({ id: p.id, title: p.title, badge: levelLabel(levelOf(p)), path: pathOf(p, ctx.byId).join(' › ') })
    const k = q.trim().toLowerCase()
    return k ? rows.filter((r) => `${r.title} ${r.path}`.toLowerCase().includes(k)) : rows
  }, [parents, rootOk, q, todo.kind, ctx.byId])

  async function choose(id: string | null): Promise<void> {
    const parent = id ? ctx.byId.get(id) ?? null : null
    const r = reparent(todo, parent, ctx.all)
    if ('error' in r) { setErr(r.error); return }
    // 放到新位置的末尾
    const last = Math.max(0, ...(ctx.kids.get(id) ?? []).map((t) => t.sort_order))
    await applyPatches([{ id: todo.id, changes: { ...r.changes, sort_order: last + 10 } }], ctx.all)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh]" onClick={onClose}>
      <div className="w-full max-w-md card p-0 overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="移动到">
        <div className="px-4 pt-3 pb-2 border-b border-line">
          <div className="text-[11px] text-text-3 truncate">移动「{todo.title}」到…</div>
          <input
            autoFocus
            className="input h-9 mt-2"
            placeholder="搜索 KR / 目标"
            value={q}
            onChange={(e) => { setQ(e.target.value); setIdx(0) }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, options.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)) }
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && options[idx]) void choose(options[idx].id)
            }}
          />
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-1">
          {options.length === 0 && <li className="px-3 py-6 text-center text-[12px] text-text-3">没有可以放的位置</li>}
          {options.map((o, i) => (
            <li key={o.id ?? 'root'}>
              <button
                onClick={() => void choose(o.id)}
                onMouseEnter={() => setIdx(i)}
                className={`w-full text-left px-3 py-2 rounded-md ${i === idx ? 'bg-bg-overlay' : ''} ${o.id === todo.parent_id ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {o.badge && <span className="shrink-0 text-[10px] font-semibold px-1.5 h-4 leading-4 rounded bg-bg-overlay text-text-2">{o.badge}</span>}
                  <span className="text-sm text-text-1 truncate">{o.title}</span>
                  {o.id === todo.parent_id && <span className="text-[11px] text-text-3 shrink-0">当前</span>}
                </div>
                {o.path && <div className="text-[11px] text-text-3 truncate mt-0.5">{o.path}</div>}
              </button>
            </li>
          ))}
        </ul>
        {err && <div className="px-4 pb-3 text-[12px] text-danger">{err}</div>}
      </div>
    </div>
  )
}
