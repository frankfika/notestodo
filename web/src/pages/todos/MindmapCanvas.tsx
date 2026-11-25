import { useLiveQuery } from 'dexie-react-hooks'
import {
  type JSX,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { applyTodoPatches } from '../../lib/mindmap/convert'
import { buildTask } from '../../lib/mindmap/createTask'
import { isDescendant } from '../../lib/mindmap/cycle'
import { tryAddTodaySlot } from '../../lib/mindmap/todayBridge'
import { getToday } from '../../lib/mindmap/todaySlots'
import {
  isMindmapEditing,
  peekMindmapUndoLabel,
  pushTodoStatusUndo,
  setMindmapEditing,
} from '../../lib/mindmap/undoStack'
import { indexByParent, isLeafTodo, todayEligible } from '../../lib/mindmap/leaf'
import { useAllTodos } from '../../lib/useAllTodos'
import { useOriginTitles } from '../../lib/originTitles'
import type { ID, Todo } from '../../types'
import { mod, now } from '../../lib/id'
import { parseQuickAdd } from '../../lib/quickAdd'
import './mindmap.css'
import { applyTodoStatus } from '../../lib/todoStatus'
import DateInput from '../../components/DateInput'
import { setDue } from './todoRowOps'

export type MindmapCanvasProps = {
  rootId: ID
  /** 有序的图根 id 列表（⌘] / ⌘[ 用它算下一张 / 上一张） */
  mapIds?: ID[]
  /** 切图回调（由页面持有图根状态） */
  onSelectMap?: (id: ID) => void
  /** 受控选中节点（页面要用它决定快速添加落到哪；不传则内部自管） */
  selectedId?: ID | null
  /** 选中变化回调（画布的选中事件同时驱动页面状态） */
  onSelectionChange?: (id: ID | null) => void
}

/* ── 自由画布 ─────────────────────────────────────────────────────────────
 * 自绘画布（不再依赖 Mind Elixir 的自动树布局）：
 *   · 每个节点有自己的世界坐标，拖到哪停在哪（pos_x/pos_y 落库）；
 *   · 没拖过的节点交给自动布局（根在正中，子级向右 DFS 排开）；
 *   · 连线按两节点的相对方向取锚点（水平出入 or 垂直出入），随拖随重算。
 * 结构语义不变：父子还是 parent_id，排序还是 sort_order，
 * 今天 / 撤销 / 来源标签全部复用原有的数据层。
 * ─────────────────────────────────────────────────────────────────────── */

type Pt = { x: number; y: number }
type Size = { w: number; h: number }
type Rect = Pt & Size

/** 自动布局层间距（按深度）：根→一级留宽一点，越深越收 */
const DX_BY_DEPTH = [0, 340, 300, 260]
const DEEP_DX = 260
/** 自动布局的纵向行距 */
const PITCH = 96
const MIN_SCALE = 0.2
const MAX_SCALE = 2
const DRAG_INTENT_PX = 5
const NODE_MAX_W = 260

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
      navigator.userAgent,
  )

/** 快捷键清单：画布右下角「说明」面板直接渲染这份表，语义与实现同源 */
const SHORTCUT_ROWS: { keys: string[]; desc: string; leaf?: boolean }[] = [
  { keys: ['Tab'], desc: '新增子任务' },
  { keys: ['Enter'], desc: '新增同级任务' },
  { keys: ['⇧', 'Tab'], desc: '提升一级' },
  { keys: ['⌥', 'Tab'], desc: '降低一级（挂到上一个同级下）' },
  { keys: ['⌥', '↑'], desc: '同级上移一位' },
  { keys: ['⌥', '↓'], desc: '同级下移一位' },
  { keys: ['F2'], desc: '改名（也可双击）' },
  { keys: ['⌫'], desc: '删除（可撤销）' },
  { keys: ['Space'], desc: '完成 / 取消完成', leaf: true },
  { keys: ['⌘', 'T'], desc: '加入 Today', leaf: true },
  { keys: ['⌘', 'Z'], desc: '撤销上一步' },
  { keys: ['⌘', ']'], desc: '下一张图' },
  { keys: ['⌘', '['], desc: '上一张图' },
  { keys: ['滚轮'], desc: '缩放画布' },
]

function keyLabel(k: string): string {
  if (k === '⌘') return mod()
  if (k === '⇧') return IS_MAC ? '⇧' : 'Shift'
  if (k === '⌥') return IS_MAC ? '⌥' : 'Alt'
  return k
}

function bump(t: Todo, patch: Partial<Todo>): Partial<Todo> {
  return { ...patch, updated_at: now(), sync_version: t.sync_version + 1 }
}

/**
 * 自动 + 手动混合布局。
 * 手动节点（拖动中 / 已落库 pos）用其坐标；自动节点挂在父级右侧，
 * 叶子按 DFS 顺序占一行，有孩子的取孩子的纵向中点。最后把自动节点
 * 整体平移到以根为纵向中心，树默认铺开但不偏到画布外。
 */
function computeLayout(
  rootId: ID,
  nodes: Todo[],
  childrenOf: Map<ID | null, Todo[]>,
  dragOv: ReadonlyMap<ID, Pt>,
): Map<ID, Pt> {
  const pos = new Map<ID, Pt>()
  let cursor = 0

  const manualOf = (t: Todo): Pt | null => {
    const ov = dragOv.get(t.id)
    if (ov) return ov
    if (typeof t.pos_x === 'number' && typeof t.pos_y === 'number') return { x: t.pos_x, y: t.pos_y }
    return null
  }

  const visit = (t: Todo, depth: number): number => {
    const kids = childrenOf.get(t.id) ?? []
    if (t.id === rootId) {
      pos.set(t.id, manualOf(t) ?? { x: 0, y: 0 })
    } else {
      const parent = t.parent_id ? pos.get(t.parent_id) : undefined
      const manual = manualOf(t)
      if (manual) {
        pos.set(t.id, manual)
      } else {
        const dx = DX_BY_DEPTH[Math.min(depth, DX_BY_DEPTH.length - 1)] ?? DEEP_DX
        pos.set(t.id, { x: (parent?.x ?? 0) + dx, y: 0 })
      }
    }
    const ys = kids.map((k) => visit(k, depth + 1))
    const me = pos.get(t.id)!
    // 根固定在 (0,0)；手动节点（拖动中 / 已落库 pos）尊重用户坐标，不重排
    if (
      t.id !== rootId &&
      !dragOv.has(t.id) &&
      !(typeof t.pos_x === 'number' && typeof t.pos_y === 'number')
    ) {
      me.y = kids.length === 0 ? (cursor += PITCH) - PITCH / 2 : avg(ys)
    }
    return me.y
  }

  const root = nodes.find((t) => t.id === rootId)
  if (root) visit(root, 0)
  return pos
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

/** 两节点间的有机连线：按相对方向选水平 / 垂直锚点，一条连续三次贝塞尔 */
function edgePath(a: Rect, b: Rect): string {
  const acy = a.y + a.h / 2
  const bcy = b.y + b.h / 2
  const acx = a.x + a.w / 2
  const bcx = b.x + b.w / 2
  const dx = bcx - acx
  const dy = bcy - acy
  if (Math.abs(dx) >= Math.abs(dy)) {
    const right = dx >= 0
    const sx = right ? a.x + a.w : a.x
    const ex = right ? b.x : b.x + b.w
    const k = Math.max(16, Math.min(140, Math.abs(ex - sx) * 0.5))
    return `M ${sx} ${acy} C ${sx + (right ? k : -k)} ${acy} ${ex + (right ? -k : k)} ${bcy} ${ex} ${bcy}`
  }
  const down = dy >= 0
  const sy = down ? a.y + a.h : a.y
  const ey = down ? b.y : b.y + b.h
  const k = Math.max(16, Math.min(120, Math.abs(ey - sy) * 0.5))
  return `M ${acx} ${sy} C ${acx} ${sy + (down ? k : -k)} ${bcx} ${ey + (down ? -k : k)} ${bcx} ${ey}`
}

type DropMode = 'in' | 'before' | 'after'
type DropHint = { id: ID; mode: DropMode }

/** 基线布局用的空覆盖表（拖动位移在布局之后单独叠加，保证其它节点不漂移） */
const EMPTY_DRAG_OV: ReadonlyMap<ID, Pt> = new Map()

export default function MindmapCanvas({
  rootId,
  mapIds,
  onSelectMap,
  selectedId: selectedIdProp,
  onSelectionChange,
}: MindmapCanvasProps): JSX.Element {
  const openTaskDetail = useUI((s) => s.openTaskDetail)
  const vpRef = useRef<HTMLDivElement>(null)
  const coachTimer = useRef<number | null>(null)
  const [coach, setCoach] = useState<string | null>(null)
  const [showKeys, setShowKeys] = useState(false)
  const [draggingUi, setDraggingUi] = useState(false)
  /** 视图（平移 + 缩放）：世界坐标 → 屏幕 */
  const [view, setView] = useState<Pt & { scale: number }>({ x: 0, y: 0, scale: 1 })
  /** 拖动中的实时坐标覆盖（不落库，松手才提交） */
  const [dragOv, setDragOv] = useState<Map<ID, Pt>>(new Map())
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const [editing, setEditing] = useState<{ id: ID; isNew: boolean } | null>(null)
  /** 折叠的子树根 id（本图作用域，存 kv） */
  const collapsedKey = useMemo(() => `mindmap.collapsed.${rootId}`, [rootId])
  const collapsedRow = useLiveQuery(() => db.kv.get(collapsedKey), [collapsedKey])
  const collapsed = useMemo(
    () => new Set(Array.isArray(collapsedRow?.value) ? (collapsedRow!.value as ID[]) : []),
    [collapsedRow],
  )

  const [internalSelectedId, setInternalSelectedId] = useState<ID | null>(null)
  const selectedId = selectedIdProp !== undefined ? selectedIdProp : internalSelectedId
  const setSelectedId = useCallback(
    (id: ID | null) => {
      setInternalSelectedId(id)
      onSelectionChange?.(id)
    },
    [onSelectionChange],
  )

  const todos = useAllTodos()
  const focusId = useUI((s) => s.todoFocusId)
  const goNote = useUI((s) => s.goNote)
  const goMeeting = useUI((s) => s.goMeeting)
  const origins = useOriginTitles(todos)

  /** 本图全部活节点（含折叠起来的子树，折叠只是不画） */
  const mapTodos = useMemo(
    () => todos.filter((t) => t.deleted_at === null && t.status !== 'cancelled' && (t.id === rootId || t.map_id === rootId)),
    [todos, rootId],
  )
  const byParentAll = useMemo(() => indexByParent(mapTodos), [mapTodos])
  const childrenSorted = useCallback(
    (id: ID): Todo[] =>
      [...(byParentAll.get(id) ?? [])].sort((a, b) => a.sort_order - b.sort_order),
    [byParentAll],
  )

  /** 可见节点：从根 DFS，穿过未折叠的边 */
  const visible = useMemo(() => {
    const out: Todo[] = []
    const walk = (id: ID): void => {
      for (const k of childrenSorted(id)) {
        out.push(k)
        if (!collapsed.has(k.id)) walk(k.id)
      }
    }
    walk(rootId)
    return out
  }, [childrenSorted, collapsed, rootId])

  /** 折叠节点的隐藏后代计数（角标用） */
  const hiddenCount = useMemo(() => {
    const m = new Map<ID, number>()
    const count = (id: ID): number =>
      childrenSorted(id).reduce((acc, k) => acc + 1 + (collapsed.has(k.id) ? 0 : count(k.id)), 0)
    for (const t of visible) {
      if (collapsed.has(t.id)) m.set(t.id, count(t.id))
    }
    return m
  }, [visible, childrenSorted, collapsed])

  /**
   * 布局分两阶段：先算「无拖动覆盖」的基线（自动节点的槽位因此稳定，
   * 拖一个节点时其它节点绝不漂移），再把拖动节点的位移刚性应用到整棵子树。
   */
  const positions = useMemo(() => {
    const base = computeLayout(rootId, mapTodos, byParentAll, EMPTY_DRAG_OV)
    if (dragOv.size === 0) return base
    const out = new Map(base)
    const stack: Array<[ID, number, number]> = []
    for (const [id, pt] of dragOv) {
      const b = base.get(id)
      if (b) stack.push([id, pt.x - b.x, pt.y - b.y])
    }
    while (stack.length > 0) {
      const [id, ddx, ddy] = stack.pop()!
      const p = out.get(id)
      if (p) out.set(id, { x: p.x + ddx, y: p.y + ddy })
      for (const k of byParentAll.get(id) ?? []) stack.push([k.id, ddx, ddy])
    }
    return out
  }, [rootId, mapTodos, byParentAll, dragOv])

  /** 实测节点尺寸（offset 尺寸不受缩放影响），供连线锚点用 */
  const sizesRef = useRef<Map<ID, Size>>(new Map())
  const [measuredEpoch, setMeasuredEpoch] = useState(0)
  useLayoutEffect(() => {
    const root = vpRef.current
    if (!root) return
    let changed = false
    const seen = new Set<ID>()
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-mm-node]'))) {
      const id = el.dataset.mmNode ?? ''
      if (!id) continue
      seen.add(id)
      const w = Math.max(el.offsetWidth, 40)
      const h = Math.max(el.offsetHeight, 28)
      const prev = sizesRef.current.get(id)
      if (!prev || prev.w !== w || prev.h !== h) {
        sizesRef.current.set(id, { w, h })
        changed = true
      }
    }
    for (const id of [...sizesRef.current.keys()]) {
      if (!seen.has(id)) {
        sizesRef.current.delete(id)
        changed = true
      }
    }
    if (changed) setMeasuredEpoch((n) => n + 1)
  })
  void measuredEpoch // 尺寸变化触发重渲染，让连线吃到新锚点

  const rects = useMemo(() => {
    const m = new Map<ID, Rect>()
    for (const [id, p] of positions) {
      const s = sizesRef.current.get(id) ?? { w: 160, h: 36 }
      m.set(id, { ...p, ...s })
    }
    return m
    // measuredEpoch：尺寸实测更新后重算锚点
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, measuredEpoch])

  /** 每次渲染把高频读写的快照挂到 ref，窗口级指针事件用 */
  const snapRef = useRef({ rects, positions, view, visibleIds: new Set<ID>(), mapTodos, rootId })
  snapRef.current = {
    rects,
    positions,
    view,
    visibleIds: new Set(visible.map((t) => t.id).concat(rootId)),
    mapTodos,
    rootId,
  }

  /** R1 · 规则提示：非模态浮层，3.2s 后自动消失 */
  const say = useCallback((msg: string): void => {
    setCoach(msg)
    if (coachTimer.current !== null) window.clearTimeout(coachTimer.current)
    coachTimer.current = window.setTimeout(() => setCoach(null), 3200)
  }, [])

  useEffect(
    () => () => {
      if (coachTimer.current !== null) window.clearTimeout(coachTimer.current)
    },
    [],
  )

  const rootTodo = mapTodos.find((t) => t.id === rootId)

  /** 自适应：按全部可见节点的包围盒缩放 + 居中（下限保护可读性） */
  const fitToView = useCallback((): void => {
    const vp = vpRef.current
    const { rects: r } = snapRef.current
    if (!vp || r.size === 0) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const b of r.values()) {
      if (b.x < minX) minX = b.x
      if (b.y < minY) minY = b.y
      if (b.x + b.w > maxX) maxX = b.x + b.w
      if (b.y + b.h > maxY) maxY = b.y + b.h
    }
    const bw = Math.max(maxX - minX, 120)
    const bh = Math.max(maxY - minY, 80)
    const vw = vp.clientWidth
    const vh = vp.clientHeight
    // 窄屏（手机）保底放大到 0.62：宁可少看一点，也不把节点缩成蚂蚁
    const minScale = vw < 640 ? 0.62 : 0.25
    const scale = Math.min(1.15, Math.max(minScale, Math.min(vw / (bw + 160), vh / (bh + 160))))
    // 某一轴放不下时改为对齐起点（左 / 上），保证读图起点（根节点）始终在视野里
    const margin = 16
    const x = (bw + 160) * scale <= vw
      ? vw / 2 - (minX + bw / 2) * scale
      : margin - minX * scale
    const y = (bh + 160) * scale <= vh
      ? vh / 2 - (minY + bh / 2) * scale
      : margin - minY * scale
    setView({ scale, x, y })
  }, [])

  /** 首次有数据 / 切图后自动适应一次 */
  const fittedForRef = useRef<ID | null>(null)
  useEffect(() => {
    if (fittedForRef.current === rootId || visible.length === 0) return
    fittedForRef.current = rootId
    requestAnimationFrame(() => fitToView())
  }, [rootId, visible.length, fitToView, measuredEpoch])

  /** focusId（从别的视图带过来）：选中并滚到它 */
  useEffect(() => {
    if (!focusId) return
    const { rects: r, view: v } = snapRef.current
    const b = r.get(focusId)
    const vp = vpRef.current
    if (!b || !vp) return
    setSelectedId(focusId)
    setView({
      scale: v.scale,
      x: vp.clientWidth / 2 - (b.x + b.w / 2) * v.scale,
      y: vp.clientHeight / 2 - (b.y + b.h / 2) * v.scale,
    })
    useUI.setState({ todoFocusId: null })
  }, [focusId, setSelectedId])

  /* ── 指针手势：拖节点（自由摆放 / 换父级 / 排序）+ 空白处平移 ─────────── */
  const gestureRef = useRef<
    | { type: 'node'; id: ID; startX: number; startY: number; orig: Pt; moved: boolean }
    | { type: 'pan'; startX: number; startY: number; orig: Pt }
    | null
  >(null)
  const suppressClickUntil = useRef(0)
  const dragHintArmed =
    typeof localStorage !== 'undefined' && !localStorage.getItem('mindmap_free_drag_v1')

  const onNodePointerDown = useCallback(
    (e: React.PointerEvent, t: Todo): void => {
      if (e.button !== 0) return
      const { positions: p } = snapRef.current
      gestureRef.current = {
        type: 'node',
        id: t.id,
        startX: e.clientX,
        startY: e.clientY,
        orig: { ...(p.get(t.id) ?? { x: 0, y: 0 }) },
        moved: false,
      }
    },
    [],
  )

  const onBackgroundPointerDown = useCallback((e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const { view: v } = snapRef.current
    gestureRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, orig: { x: v.x, y: v.y } }
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const g = gestureRef.current
      if (!g) return
      const dx = e.clientX - g.startX
      const dy = e.clientY - g.startY
      if (g.type === 'pan') {
        setView((v) => ({ ...v, x: g.orig.x + dx, y: g.orig.y + dy }))
        return
      }
      if (!g.moved && Math.hypot(dx, dy) < DRAG_INTENT_PX) return
      if (!g.moved) {
        g.moved = true
        setDraggingUi(true)
        if (dragHintArmed) {
          localStorage.setItem('mindmap_free_drag_v1', '1')
          say('拖到空白处 = 自由摆放；拖到节点上 = 挂到它下面；拖到上 / 下边缘 = 排序')
        }
      }
      const { view: v, rects: r } = snapRef.current
      const next: Pt = { x: g.orig.x + dx / v.scale, y: g.orig.y + dy / v.scale }
      setDragOv((m) => {
        const n = new Map(m)
        n.set(g.id, next)
        return n
      })
      // 落点探测：指针压住的其它节点（上/下 35% 是排序带，中间是成为子级）
      // 注意坐标换算要减掉视口自身的页面偏移（侧栏 + 页头）
      const vp = vpRef.current
      if (!vp) return
      const vpRect = vp.getBoundingClientRect()
      const wx = (e.clientX - vpRect.left - v.x) / v.scale
      const wy = (e.clientY - vpRect.top - v.y) / v.scale
      let hint: DropHint | null = null
      for (const [id, b] of r) {
        if (id === g.id) continue
        if (wx < b.x - 8 || wx > b.x + b.w + 8 || wy < b.y - 10 || wy > b.y + b.h + 10) continue
        const rel = (wy - b.y) / b.h
        const mode: DropMode = rel < 0.35 ? 'before' : rel > 0.65 ? 'after' : 'in'
        hint = { id, mode: id === snapRef.current.rootId && mode !== 'in' ? 'in' : mode }
        break
      }
      setDropHint(hint)
    }
    const onUp = (e: PointerEvent): void => {
      const g = gestureRef.current
      gestureRef.current = null
      if (!g) return
      if (g.type === 'pan') return
      if (!g.moved) return
      suppressClickUntil.current = performance.now() + 220
      setDraggingUi(false)
      const hint = dropHintRef.current
      setDragOv(new Map())
      setDropHint(null)
      const snap = snapRef.current
      const cur = snap.mapTodos.find((t) => t.id === g.id)
      if (!cur) return
      const finalPos = snap.positions.get(g.id) ?? g.orig
      void (async () => {
        if (hint && hint.id !== g.id && !isDescendant(g.id, hint.id, new Map(snap.mapTodos.map((t) => [t.id, t])))) {
          await dropOnNode(cur, hint, finalPos)
        } else {
          // 自由摆放：把这个坐标存下来
          await applyTodoPatches(
            [{ op: 'update', id: cur.id, patch: bump(cur, { pos_x: finalPos.x, pos_y: finalPos.y }) }],
            { scope: rootId },
          )
        }
      })()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId])

  /** dropHint 的 ref 镜像：窗口级 pointerup 闭包拿不到最新 state */
  const dropHintRef = useRef<DropHint | null>(null)
  dropHintRef.current = dropHint

  /** 拖到别的节点上：成为子级 / 插到前 / 插到后（结构走补丁，可撤销） */
  const dropOnNode = useCallback(
    async (t: Todo, hint: DropHint, pos: Pt): Promise<void> => {
      const all = snapRef.current.mapTodos
      const byId = new Map(all.map((x) => [x.id, x]))
      const target = byId.get(hint.id)
      if (!target) return
      let parentId: ID
      let sortOrder: number
      if (hint.mode === 'in') {
        parentId = target.id
        const kids = all.filter((k) => k.parent_id === parentId && k.deleted_at === null)
        sortOrder = Math.max(0, ...kids.map((k) => k.sort_order)) + 10
      } else {
        parentId = target.parent_id ?? rootId
        const anchorOrder = target.sort_order
        const sibs = all
          .filter((k) => k.parent_id === parentId && k.deleted_at === null && k.id !== t.id)
          .sort((a, b) => a.sort_order - b.sort_order)
        const aidx = sibs.findIndex((s) => s.id === target.id)
        if (hint.mode === 'after') {
          const next = aidx >= 0 ? sibs[aidx + 1] : undefined
          sortOrder = next ? (anchorOrder + next.sort_order) / 2 : anchorOrder + 10
        } else {
          const prev = aidx > 0 ? sibs[aidx - 1] : undefined
          sortOrder = prev ? (prev.sort_order + anchorOrder) / 2 : anchorOrder - 10
        }
      }
      const newMap = parentId === rootId ? rootId : (byId.get(parentId)?.map_id ?? rootId)
      await applyTodoPatches(
        [
          {
            op: 'update',
            id: t.id,
            patch: bump(t, { parent_id: parentId, map_id: newMap, sort_order: sortOrder, pos_x: pos.x, pos_y: pos.y }),
          },
        ],
        { scope: rootId },
      )
    },
    [rootId],
  )

  /* ── 滚轮缩放（以指针为锚点） ─────────────────────────────────────────── */
  useEffect(() => {
    const vp = vpRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      setView((v) => {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * Math.exp(-e.deltaY * 0.0012)))
        const k = scale / v.scale
        return { scale, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k }
      })
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [])

  /* ── 编辑（加节点 = 加任务，创建即改名） ────────────────────────────── */
  const startEdit = useCallback((id: ID, isNew = false): void => {
    setSelectedId(id)
    setEditing({ id, isNew })
    setMindmapEditing(true)
  }, [setSelectedId])

  const commitEdit = useCallback(
    async (text: string): Promise<void> => {
      const cur = snapRef.current.mapTodos.find((t) => t.id === editing?.id)
      const wasNew = editing?.isNew ?? false
      setEditing(null)
      setMindmapEditing(false)
      if (!cur) return
      const parsed = parseQuickAdd(text)
      if (wasNew && !parsed.title) {
        // 新任务没写名字就撤 —— 不留空壳（与列表 Esc 丢弃同口径）
        await applyTodoPatches([{ op: 'softDeleteSubtree', rootId: cur.id }], { scope: rootId })
        return
      }
      const patch: Partial<Todo> = {}
      if (parsed.title && parsed.title !== cur.title) patch.title = parsed.title
      if (parsed.assignee && parsed.assignee !== cur.assignee) patch.assignee = parsed.assignee
      if (parsed.due_date && parsed.due_date !== cur.due_date) patch.due_date = parsed.due_date
      if (Object.keys(patch).length === 0) return
      await applyTodoPatches([{ op: 'update', id: cur.id, patch: bump(cur, patch) }], { scope: rootId })
    },
    [editing, rootId],
  )

  const cancelEdit = useCallback(async (): Promise<void> => {
    const cur = snapRef.current.mapTodos.find((t) => t.id === editing?.id)
    const wasNew = editing?.isNew ?? false
    setEditing(null)
    setMindmapEditing(false)
    if (cur && wasNew) {
      await applyTodoPatches([{ op: 'softDeleteSubtree', rootId: cur.id }], { scope: rootId })
    }
  }, [editing, rootId])

  /** 新增子任务：落库 + 立刻进改名 —— 添加节点时就把任务写了 */
  const addChild = useCallback(
    async (parent: Todo): Promise<void> => {
      const kids = childrenSorted(parent.id)
      const todo = buildTask({
        title: '',
        placement: { parentId: parent.id, mapId: rootId },
        sortOrder: Math.max(0, ...kids.map((k) => k.sort_order)) + 10,
      })
      await applyTodoPatches([{ op: 'add', todo }], { scope: rootId })
      startEdit(todo.id, true)
    },
    [childrenSorted, rootId, startEdit],
  )

  /** 新增同级任务（插在锚点后面；⇧Enter 走 before） */
  const addSibling = useCallback(
    async (anchor: Todo, where: 'before' | 'after'): Promise<void> => {
      const parentId = anchor.parent_id ?? rootId
      const sibs = mapTodos
        .filter((t) => t.parent_id === parentId && t.deleted_at === null)
        .sort((a, b) => a.sort_order - b.sort_order)
      const idx = sibs.findIndex((s) => s.id === anchor.id)
      let sortOrder: number
      if (where === 'after') {
        const next = sibs[idx + 1]
        sortOrder = next ? (anchor.sort_order + next.sort_order) / 2 : anchor.sort_order + 10
      } else {
        const prev = idx > 0 ? sibs[idx - 1] : undefined
        sortOrder = prev ? (prev.sort_order + anchor.sort_order) / 2 : anchor.sort_order - 10
      }
      const todo = buildTask({
        title: '',
        placement: { parentId, mapId: rootId },
        sortOrder,
      })
      await applyTodoPatches([{ op: 'add', todo }], { scope: rootId })
      startEdit(todo.id, true)
    },
    [mapTodos, rootId, startEdit],
  )

  /** 软删子树（可撤销） */
  const removeNode = useCallback(
    (t: Todo): void => {
      if (t.id === rootId) {
        say('根节点不能删除')
        return
      }
      void applyTodoPatches([{ op: 'softDeleteSubtree', rootId: t.id }], { scope: rootId })
    },
    [rootId, say],
  )

  /** 完成 / 取消完成（Space 与操作栏共用一条路径） */
  const toggleDone = useCallback(
    async (t: Todo): Promise<void> => {
      if (t.id === rootId) {
        say('这是图根，不能直接完成')
        return
      }
      if (!isLeafTodo(t, byParentAll)) {
        say('结构节点不能直接完成 —— 按 Tab 拆成一步再完成')
        return
      }
      const todayBefore = await getToday()
      pushTodoStatusUndo(t.id, t.status, rootId, todayBefore)
      await applyTodoStatus(t, t.status === 'done' ? 'open' : 'done')
      const verb = t.status === 'done' ? '已取消完成' : '已完成'
      const undoable = peekMindmapUndoLabel(rootId) ? ` · ${mod()}Z 可撤销` : ''
      say(`${verb}「${t.title || '未命名'}」${undoable}`)
    },
    [byParentAll, rootId, say],
  )

  /** 同级上移 / 下移（⌥↑/⌥↓ 与操作栏按钮共用一条路径，不换父级） */
  const moveSibling = useCallback(
    (t: Todo, dir: -1 | 1): void => {
      if (t.id === rootId) {
        say('根节点不能移动')
        return
      }
      const sibs = (byParentAll.get(t.parent_id) ?? [])
        .filter((s) => s.status !== 'done')
        .sort((a, b) => a.sort_order - b.sort_order)
      const idx = sibs.findIndex((s) => s.id === t.id)
      const neighbor = sibs[idx + dir]
      if (!neighbor) {
        say(dir === -1 ? '已经是第一个了' : '已经是最后一个了')
        return
      }
      const lo = Math.min(t.sort_order, neighbor.sort_order)
      const hi = Math.max(t.sort_order, neighbor.sort_order)
      void applyTodoPatches(
        [
          { op: 'update', id: t.id, patch: bump(t, { sort_order: dir === -1 ? lo - 5 : hi + 5 }) },
        ],
        { scope: rootId },
      )
    },
    [byParentAll, rootId, say],
  )

  /** 入 Today（⌘T 与操作栏共用一条路径） */
  const addToday = useCallback(
    async (t: Todo): Promise<void> => {
      if (!todayEligible(t, byParentAll)) {
        const msg = t.waiting_reason
          ? '等待中的任务不能加入今天，先清掉等待原因或拆成下一步'
          : !isLeafTodo(t, byParentAll)
            ? '先拆成一步（按 Tab 加子节点），再 ⌘T'
            : '当前节点不可入 Today'
        say(msg)
        return
      }
      setCoach(null)
      await tryAddTodaySlot(t.id, rootId)
    },
    [byParentAll, rootId, say],
  )

  /** 节点截止日期：在脑图里直接改 */
  const setDueDate = useCallback(
    async (t: Todo, due: string): Promise<void> => {
      const next = due || null
      if ((t.due_date ?? null) === next) return
      await setDue(t, next)
      say(next ? `已设截止 ${next.slice(5, 10).replace('-', '/')}` : '已清掉截止日期')
    },
    [say],
  )

  /** 切换折叠（kv 持久化，切图后保持） */
  const toggleCollapse = useCallback(
    (id: ID): void => {
      const next = new Set(collapsed)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      void db.kv.put({ key: collapsedKey, value: [...next] })
    },
    [collapsed, collapsedKey],
  )

  /** 空图 / 停靠栏共用的添加入口：选中节点的下面，没选中就挂图根 */
  const addFromDock = useCallback((): void => {
    const sel = selectedId ? mapTodos.find((t) => t.id === selectedId) : undefined
    const target = sel && sel.id !== rootId ? sel : (rootTodo ?? sel)
    if (!target) return
    void addChild(target)
  }, [selectedId, mapTodos, rootId, rootTodo, addChild])

  /** F-02 · ⌘] / ⌘[ 切图 */
  const switchMap = useCallback(
    (dir: 1 | -1): void => {
      const ids = mapIds ?? []
      if (ids.length <= 1) {
        say('只有一张图 —— 在左上角切图入口新建')
        return
      }
      const idx = ids.findIndex((id) => id === rootId)
      const next = ids[(idx + dir + ids.length) % ids.length]
      if (next && onSelectMap) onSelectMap(next)
    },
    [mapIds, onSelectMap, rootId, say],
  )

  /** 画布内不响应窗口快捷键的目标（输入中 / 别的控件上） */
  const isTypingTarget = (el: EventTarget | null): boolean => {
    const h = el as HTMLElement | null
    return Boolean(
      h && (h.tagName === 'INPUT' || h.tagName === 'TEXTAREA' || h.tagName === 'BUTTON' || h.isContentEditable),
    )
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return
      if (isMindmapEditing()) return
      const isMod = e.metaKey || e.ctrlKey

      if (isMod && (e.key === ']' || e.key === '[')) {
        e.preventDefault()
        switchMap(e.key === ']' ? 1 : -1)
        return
      }
      const t = selectedId ? mapTodos.find((x) => x.id === selectedId) : undefined
      if (!t) return

      if (e.code === 'Space') {
        e.preventDefault()
        void toggleDone(t)
        return
      }
      if (isMod && e.key.toLowerCase() === 't') {
        e.preventDefault()
        void addToday(t)
        return
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        moveSibling(t, e.key === 'ArrowUp' ? -1 : 1)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        if (e.shiftKey) {
          // 提升一级：挂到父级的后面
          if (!t.parent_id || t.parent_id === rootId) {
            say('已经是最外层了')
            return
          }
          const parent = mapTodos.find((x) => x.id === t.parent_id)
          if (!parent) return
          void applyTodoPatches(
            [
              {
                op: 'update',
                id: t.id,
                patch: bump(t, { parent_id: parent.parent_id ?? rootId, sort_order: parent.sort_order + 5 }),
              },
            ],
            { scope: rootId },
          )
          return
        }
        if (e.altKey) {
          // 降低一级：挂到上一个同级下
          const sibs = (byParentAll.get(t.parent_id) ?? [])
            .filter((s) => s.status !== 'done')
            .sort((a, b) => a.sort_order - b.sort_order)
          const idx = sibs.findIndex((s) => s.id === t.id)
          const prev = idx > 0 ? sibs[idx - 1] : undefined
          if (!prev) {
            say('已经是第一个同级 —— 没有更上一层可挂')
            return
          }
          void applyTodoPatches(
            [
              {
                op: 'update',
                id: t.id,
                patch: bump(t, { parent_id: prev.id, sort_order: Date.now() }),
              },
            ],
            { scope: rootId },
          )
          return
        }
        void addChild(t)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (isMod) {
          startEdit(t.id)
          return
        }
        if (t.id === rootId) {
          say('根节点没有同级 —— 按 Tab 加子任务')
          return
        }
        void addSibling(t, e.shiftKey ? 'before' : 'after')
        return
      }
      if (e.key === 'F2') {
        e.preventDefault()
        startEdit(t.id)
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        removeNode(t)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, mapTodos, rootId, say, switchMap, toggleDone, addToday, moveSibling, addChild, addSibling, startEdit, removeNode, byParentAll])

  /* ── 渲染 ─────────────────────────────────────────────────────────── */

  const selectedTodo = selectedId ? mapTodos.find((x) => x.id === selectedId) : undefined
  const showActionBar = Boolean(selectedTodo && snapRef.current.visibleIds.has(selectedTodo.id) && !editing)
  const rootKids = childrenSorted(rootId)

  const originJump = selectedTodo
    ? selectedTodo.origin_note_id
      ? {
          label: `✎ ${origins.noteTitles.get(selectedTodo.origin_note_id) ?? '查看笔记'}`,
          run: () => goNote(selectedTodo.origin_note_id!),
        }
      : selectedTodo.meeting_id
        ? {
            label: `● ${origins.meetingTitles.get(selectedTodo.meeting_id) ?? '查看会议'}`,
            run: () => goMeeting(selectedTodo.meeting_id!),
          }
        : null
    : null

  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  /** 节点卡片上的信息 chip（@负责人 / 截止 / 等待 / 来源） */
  const chipsFor = (t: Todo): JSX.Element | null => {
    const chips: JSX.Element[] = []
    if (t.assignee) chips.push(<span key="a" className="mm-chip">@{t.assignee}</span>)
    if (t.due_date) {
      const overdue = t.due_date < todayIso
      chips.push(
        <span
          key="d"
          className={`mm-chip ${overdue ? 'mm-chip-overdue' : t.due_date === todayIso ? 'mm-chip-today' : ''}`}
        >
          {overdue ? `逾期 ${t.due_date.slice(5, 10).replace('-', '/')}` : `截止 ${t.due_date.slice(5, 10).replace('-', '/')}`}
        </span>,
      )
    }
    if (t.waiting_reason && t.status === 'open') chips.push(<span key="w" className="mm-chip mm-chip-waiting">等待中</span>)
    if (t.origin_note_id) {
      chips.push(
        <button
          key="n"
          type="button"
          className="mm-chip mm-chip-origin"
          title={`跳到来源笔记（✎ ${origins.noteTitles.get(t.origin_note_id) ?? '笔记'}）`}
          onClick={(e) => {
            e.stopPropagation()
            goNote(t.origin_note_id!)
          }}
        >
          ✎ {(origins.noteTitles.get(t.origin_note_id) ?? '笔记').slice(0, 12)}
        </button>,
      )
    } else if (t.meeting_id) {
      chips.push(
        <button
          key="m"
          type="button"
          className="mm-chip mm-chip-origin"
          title={`跳到来源会议（● ${origins.meetingTitles.get(t.meeting_id) ?? '会议'}）`}
          onClick={(e) => {
            e.stopPropagation()
            goMeeting(t.meeting_id!)
          }}
        >
          ● {(origins.meetingTitles.get(t.meeting_id) ?? '会议').slice(0, 12)}
        </button>,
      )
    }
    if (chips.length === 0) return null
    return <span className="mm-chips">{chips}</span>
  }

  return (
    <div className={`mindmap-wrap${draggingUi ? ' is-dragging' : ''}`}>
      <div
        ref={vpRef}
        className="mindmap-viewport mindmap-canvas"
        data-testid="mindmap-canvas"
        onPointerDown={onBackgroundPointerDown}
        onClick={() => setSelectedId(null)}
      >
        <div
          className="mindmap-world"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          {/* 连线层 */}
          <svg className="mindmap-edges" aria-hidden="true">
            {visible.map((t) => {
              if (!t.parent_id) return null
              const a = rects.get(t.parent_id)
              const b = rects.get(t.id)
              if (!a || !b) return null
              return <path key={t.id} d={edgePath(a, b)} />
            })}
          </svg>

          {/* 节点层 */}
          {mapTodos.map((t) => {
            if (t.id !== rootId && !snapRef.current.visibleIds.has(t.id)) return null
            const p = positions.get(t.id)
            if (!p) return null
            const isRoot = t.id === rootId
            const isSel = selectedId === t.id
            const done = t.status === 'done'
            const kids = childrenSorted(t.id)
            const isCollapsed = collapsed.has(t.id)
            const hint = dropHint?.id === t.id ? dropHint : null
            const count = hiddenCount.get(t.id)
            return (
              <div
                key={t.id}
                data-mm-node={t.id}
                data-testid="mm-node"
                className={[
                  'mm-node',
                  isRoot ? 'mm-root' : '',
                  isSel ? 'is-selected' : '',
                  done ? 'is-done' : '',
                  t.waiting_reason && t.status === 'open' ? 'is-waiting' : '',
                  draggingUi && dragOv.has(t.id) ? 'is-dragging' : '',
                ].filter(Boolean).join(' ')}
                style={{
                  left: p.x,
                  top: p.y,
                  maxWidth: isRoot ? undefined : NODE_MAX_W,
                }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  onNodePointerDown(e, t)
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  if (performance.now() < suppressClickUntil.current) return
                  if (isSel) startEdit(t.id)
                  else setSelectedId(t.id)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (performance.now() < suppressClickUntil.current) return
                  startEdit(t.id)
                }}
              >
                {hint?.mode === 'in' && <span className="mm-drop-in" aria-hidden="true" />}
                {hint?.mode === 'before' && <span className="mm-drop-line mm-drop-before" aria-hidden="true" />}
                {hint?.mode === 'after' && <span className="mm-drop-line mm-drop-after" aria-hidden="true" />}
                {kids.length > 0 && (
                  <button
                    type="button"
                    className="mm-fold"
                    aria-label={isCollapsed ? `展开 ${hiddenCount.get(t.id) ?? kids.length} 条` : '折叠子树'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleCollapse(t.id)
                    }}
                  >
                    {isCollapsed ? '▸' : '▾'}
                  </button>
                )}
                <div className="mm-title">{t.title || '未命名'}</div>
                {chipsFor(t)}
                {isCollapsed && count !== undefined && count > 0 && (
                  <span className="mm-count" aria-hidden="true">{count}</span>
                )}
                {!isRoot && (
                  <button
                    type="button"
                    className="mm-node-add"
                    aria-label="添加子任务"
                    title="添加子任务（Tab）"
                    onClick={(e) => {
                      e.stopPropagation()
                      void addChild(t)
                    }}
                  >
                    ＋
                  </button>
                )}
              </div>
            )
          })}

          {/* 行内改名：加节点 = 写任务，创建即编辑 */}
          {editing &&
            (() => {
              const p = positions.get(editing.id)
              if (!p) return null
              return (
                <input
                  key={editing.id}
                  data-testid="mm-editor"
                  className="mm-editor"
                  style={{ left: p.x - 2, top: p.y - 2 }}
                  defaultValue={mapTodos.find((t) => t.id === editing.id)?.title ?? ''}
                  placeholder="要做什么？回车创建，支持「@张三 明天」"
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void commitEdit(e.currentTarget.value)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      void cancelEdit()
                    }
                  }}
                  onBlur={(e) => void commitEdit(e.target.value)}
                />
              )
            })()}
        </div>
      </div>

      {/* 内联教练提示 */}
      <div className="mindmap-coach" role="status" data-show={coach ? '1' : '0'}>
        {coach ?? ''}
      </div>

      {/* 空图引导 */}
      {rootKids.length === 0 && rootTodo && (
        <div className="mindmap-empty">
          <div className="mindmap-empty-title">先从一条真正要推进的事开始</div>
          <button type="button" className="mindmap-empty-btn" onClick={() => void addChild(rootTodo)}>
            ＋ 添加第一条任务
          </button>
          <div className="mindmap-empty-hint">
            点一下就能写任务；写完回车，再用 Tab 逐层拆开。
          </div>
        </div>
      )}

      {/* 选中节点的操作栏 */}
      {showActionBar && selectedTodo && (
        <div className="mindmap-actionbar" role="toolbar" aria-label="节点操作">
          <button type="button" onClick={() => void addChild(selectedTodo)}>
            子任务 <kbd className="mindmap-kbd">Tab</kbd>
          </button>
          <button
            type="button"
            disabled={selectedTodo.id === rootId}
            onClick={() => void addSibling(selectedTodo, 'after')}
          >
            同级 <kbd className="mindmap-kbd">{IS_MAC ? '⏎' : 'Enter'}</kbd>
          </button>
          <span className="mindmap-actionbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="mindmap-actionbar-icon"
            aria-label="上移"
            title={`上移（${keyLabel('⌥')}↑）`}
            disabled={selectedTodo.id === rootId}
            onClick={() => moveSibling(selectedTodo, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="mindmap-actionbar-icon"
            aria-label="下移"
            title={`下移（${keyLabel('⌥')}↓）`}
            disabled={selectedTodo.id === rootId}
            onClick={() => moveSibling(selectedTodo, 1)}
          >
            ↓
          </button>
          <span className="mindmap-actionbar-sep" aria-hidden="true" />
          <button type="button" onClick={() => startEdit(selectedTodo.id)}>
            改名 <kbd className="mindmap-kbd">F2</kbd>
          </button>
          <div className="mindmap-actionbar-date">
            <span className="mindmap-actionbar-label">截止</span>
            <DateInput
              value={selectedTodo.due_date ?? ''}
              onChange={(value) => void setDueDate(selectedTodo, value)}
              title="设置截止日期"
              className="mindmap-actionbar-dateinput"
            />
            {selectedTodo.due_date && (
              <button
                type="button"
                className="mindmap-actionbar-icon"
                aria-label="清空截止日期"
                title="清空截止日期"
                onClick={() => void setDueDate(selectedTodo, '')}
              >
                ×
              </button>
            )}
          </div>
          <button
            type="button"
            disabled={selectedTodo.id === rootId || !isLeafTodo(selectedTodo, byParentAll)}
            title={
              selectedTodo.id === rootId
                ? '这是图根，不能直接完成'
                : !isLeafTodo(selectedTodo, byParentAll)
                  ? '结构节点不能直接完成 —— 先拆成一步'
                  : undefined
            }
            onClick={() => void toggleDone(selectedTodo)}
          >
            {selectedTodo.status === 'done' ? '取消完成' : '✓ 完成'}{' '}
            <kbd className="mindmap-kbd">Space</kbd>
          </button>
          <button type="button" onClick={() => openTaskDetail(selectedTodo.id)}>
            详情
          </button>
          <span className="mindmap-actionbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="mindmap-actionbar-icon"
            aria-label="入 Today"
            title={`加入 Today（${mod()}T）`}
            disabled={!todayEligible(selectedTodo, byParentAll)}
            onClick={() => void addToday(selectedTodo)}
          >
            今
          </button>
          {originJump && (
            <button
              type="button"
              className="mindmap-actionbar-source"
              aria-label={`来源：${originJump.label}`}
              title={`跳到来源（${originJump.label}）`}
              onClick={originJump.run}
            >
              来源
            </button>
          )}
          <button
            type="button"
            className="danger"
            disabled={selectedTodo.id === rootId}
            onClick={() => removeNode(selectedTodo)}
          >
            删除 <kbd className="mindmap-kbd">⌫</kbd>
          </button>
        </div>
      )}

      {/* 左下角停靠栏：添加任务的常驻入口（加节点 = 写任务）+ 视图控制 */}
      <div className="mindmap-dock">
        <button type="button" className="mindmap-dock-add" onClick={() => void addFromDock()}>
          ＋ 添加任务
        </button>
        <div className="mindmap-hint-actions">
          <button type="button" className="mindmap-hint-btn" title="缩小" onClick={() => setView((v) => ({ ...v, scale: Math.max(MIN_SCALE, v.scale / 1.2) }))}>−</button>
          <button
            type="button"
            className="mindmap-hint-btn mindmap-dock-zoom"
            title="恢复 100%"
            onClick={() => setView((v) => ({ ...v, scale: 1 }))}
          >
            {Math.round(view.scale * 100)}%
          </button>
          <button type="button" className="mindmap-hint-btn" title="放大" onClick={() => setView((v) => ({ ...v, scale: Math.min(MAX_SCALE, v.scale * 1.2) }))}>＋</button>
          <button type="button" className="mindmap-hint-btn" onClick={fitToView}>
            适应
          </button>
          <button
            type="button"
            className="mindmap-hint-btn"
            aria-expanded={showKeys}
            onClick={() => setShowKeys((v) => !v)}
          >
            说明
          </button>
        </div>
      </div>

      {/* 说明面板 */}
      {showKeys && (
        <div className="mindmap-hint-panel" role="menu" aria-label="脑图使用方式">
          <div className="mindmap-hint-title">使用方式</div>
          <div className="mindmap-hint-row">
            <span className="mindmap-hint-desc">＋ 添加任务 / 悬停节点点「＋」：建任务并直接命名</span>
          </div>
          <div className="mindmap-hint-row">
            <span className="mindmap-hint-desc">拖节点：自由摆放（位置会记住）；拖到别的节点上 = 挂到它下面</span>
          </div>
          <div className="mindmap-hint-row">
            <span className="mindmap-hint-desc">拖到节点的上 / 下边缘 = 排到它前面 / 后面</span>
          </div>
          <div className="mindmap-hint-row">
            <span className="mindmap-hint-desc">单击选中，再点一下（或双击）改名；任务里写「@张三 明天」自动识别</span>
          </div>
          <div className="mindmap-hint-title">键盘</div>
          {SHORTCUT_ROWS.map((row) => (
            <div className="mindmap-hint-row" key={row.desc}>
              <span className="mindmap-hint-keys">
                {row.keys.map((k) => (
                  <kbd className="mindmap-kbd" key={k}>
                    {keyLabel(k)}
                  </kbd>
                ))}
              </span>
              <span className="mindmap-hint-desc">
                {row.desc}
                {row.leaf && <em className="mindmap-hint-leaf">仅叶子</em>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
