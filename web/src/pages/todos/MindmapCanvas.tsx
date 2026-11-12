import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUI } from '../../state/ui'
import {
  applyTodoPatches,
  mindEventToTodoPatches,
  todosToMindData,
} from '../../lib/mindmap/convert'
import { tryAddTodaySlot } from '../../lib/mindmap/todayBridge'
import { getToday } from '../../lib/mindmap/todaySlots'
import {
  isMindmapEditing,
  pushTodoStatusUndo,
  setMindmapEditing,
} from '../../lib/mindmap/undoStack'
import { indexByParent, isLeafTodo, todayEligible } from '../../lib/mindmap/leaf'
import { useAllTodos } from '../../lib/useAllTodos'
import type { MeOperation, MindmapNodeMeta } from '../../lib/mindmap/types'
import type { ID, Todo } from '../../types'
import { mod } from '../../lib/id'
import './mindmap.css'
import { applyTodoStatus } from '../../lib/todoStatus'

export type MindmapCanvasProps = {
  rootId: ID
  /** 有序的图根 id 列表（⌘] / ⌘[ 用它算下一张 / 上一张） */
  mapIds?: ID[]
  /** 切图回调（由页面持有图根状态） */
  onSelectMap?: (id: ID) => void
}

/**
 * F-09 · 极简：ME 默认主题是 Latte 彩虹配色（11 种高饱和色），
 * 和应用的 Notion 风冲突。换成低饱和中性色，分支线不再抢焦点。
 * 颜色细节统一由 mindmap.css 接管（接应用令牌，跟随明暗）。
 */
const MINIMAL_PALETTE = ['#a3a3a0', '#b6b5b1', '#9aa3ab', '#b3a99f', '#a6a1ab']

type MindElixirInstance = {
  init: (data: unknown) => void | Promise<void>
  refresh?: (data: unknown) => void
  destroy?: () => void
  bus: { addListener: (ev: string, fn: (payload: unknown) => void) => void }
  findEle?: (id: string) => unknown
  selectNode?: (el: unknown, center?: boolean) => void
  currentNode?: { nodeObj?: { id: string } }
  container?: HTMLElement
  addChild?: () => Promise<void> | void
  insertSibling?: (type: 'before' | 'after') => Promise<void> | void
  beginEdit?: () => Promise<void> | void
  /** 直接对某个节点进编辑态（传的是 .me-tpc 元素） */
  editTopic?: (el: unknown) => void
  removeNodes?: (nodes: unknown[]) => Promise<void> | void
  moveNodesIn?: (from: unknown[], to: unknown) => Promise<void> | void
  moveNodesBefore?: (from: unknown[], to: unknown) => Promise<void> | void
  moveNodesAfter?: (from: unknown[], to: unknown) => Promise<void> | void
  /** 缩放到刚好放得下 + 按整棵树居中 */
  scaleFit?: () => void
  /**
   * 画布上现在的树。
   * 注意 ME 的两个 API 形状不一样，别踩：
   *   `getData()`      → 对象 `{ nodeData, arrows, ... }`
   *   `stringifyData()` → **JSON 字符串**（不是对象，取 `.nodeData` 永远是 undefined）
   */
  getData?: () => { nodeData?: BranchNode } | undefined
  stringifyData?: () => string | { nodeData?: BranchNode } | undefined
}

/** 拿到 ME 画布上当前的根节点（两个 API 都兼容） */
function readMeNode(mei: MindElixirInstance): BranchNode | undefined {
  const direct = mei.getData?.()?.nodeData
  if (direct) return direct
  const raw = mei.stringifyData?.()
  if (typeof raw !== 'string') return raw?.nodeData
  try {
    const parsed = JSON.parse(raw) as { nodeData?: BranchNode }
    return parsed.nodeData
  } catch {
    return undefined
  }
}

/** ME 分支生成器的入参（父节点 / 子节点的几何） */
type BranchArgs = {
  pT: number
  pL: number
  pW: number
  pH: number
  cT: number
  cL: number
  cW: number
  cH: number
  direction: 'lhs' | 'rhs' | 'down'
  containerHeight?: number
  containerWidth?: number
  isFirst?: boolean
}

type BranchNode = {
  id?: string
  topic?: string
  children?: BranchNode[]
  tags?: string[]
  metadata?: MindmapNodeMeta
}

/**
 * F-09 · 有机树枝 · 主分支（根 → 一级）。
 *
 * ME 默认是「从父节点垂直上冲 → 折一下」，看着像流程图的连线。
 * 这里改成脑图的样子：**水平出入父/子节点，中间一条连续的三次贝塞尔**。
 */
function organicMainBranch({
  pT,
  pL,
  pW,
  pH,
  cT,
  cL,
  cW,
  cH,
  direction,
}: BranchArgs): string {
  const py = pT + pH / 2
  const cy = cT + cH / 2
  if (direction === 'down') {
    const sx = pL + pW / 2
    const ex = cL + cW / 2
    const sy = pT + pH
    const ey = cT
    const k = Math.max(16, Math.min(120, (ey - sy) * 0.55))
    return `M ${sx} ${sy} C ${sx} ${sy + k} ${ex} ${ey - k} ${ex} ${ey}`
  }
  const right = direction !== 'lhs'
  const sx = right ? pL + pW : pL
  const ex = right ? cL : cL + cW
  const k = Math.max(16, Math.min(140, Math.abs(ex - sx) * 0.55))
  const c1 = right ? sx + k : sx - k
  const c2 = right ? ex - k : ex + k
  return `M ${sx} ${py} C ${c1} ${py} ${c2} ${cy} ${ex} ${cy}`
}

/**
 * F-09 · 有机树枝 · 子分支（一级 → 二级）。
 *
 * 子分支的坐标系跟主分支**不一样**：ME 把 subLines 的 SVG 挂在节点自己的
 * wrapper 里，父节点的坐标是 wrapper 局部坐标，子节点的坐标却是子节点自己
 * 盒子里的局部坐标 —— 两者不能直接相减。
 * 所以这里沿用 ME 自己的落点换算（起点 / 终点都不变，保证一定落在子节点上），
 * 只把 ME 的「三次贝塞尔 + 一段直线 H」换成**一条连续的三次贝塞尔**：
 * 去掉了那条最像流程图的直线段。
 */
function organicSubBranch(
  this: { container?: HTMLElement },
  { pT, pL, pW, pH, cT, cL, cH }: BranchArgs,
): string {
  // 子分支的坐标系：subLines 的 SVG 挂在节点的 wrapper 里。
  //   p* = 父节点 topic 在 wrapper 里的位置（直接用）
  //   c* = 子节点 wrapper 在同一个 wrapper 里的位置 —— 比 topic 多了左右各
  //        一个 --node-gap-x 的内边距，所以 topic 左缘要 + gap
  // （这几条换算是对着真实 DOM 量出来的，见 docs/phase2-claude-acceptance.md）
  const gapRaw =
    this.container && typeof getComputedStyle === 'function'
      ? getComputedStyle(this.container).getPropertyValue('--node-gap-x')
      : ''
  const gap = Number.parseInt(gapRaw, 10) || 24
  const sx = pL + pW
  const sy = pT + pH / 2
  const ex = cL + gap
  const ey = cT + cH / 2
  const k = Math.max(14, Math.min(120, Math.abs(ex - sx) * 0.55))
  return `M ${sx} ${sy} C ${sx + k} ${sy} ${ex - k} ${ey} ${ex} ${ey}`
}

/**
 * 画布上这棵树的签名（id + 标题 + 可见元信息 + 结构）。
 *
 * 用来回答一个问题：「Dexie 里的数据，画布上是不是已经画好了？」
 * 如果是，就别再 `refresh` 重画一遍 —— 重画会重建整棵 DOM，
 * ME 自己的动画、选中态全被抹掉，手感一下就变「不丝滑」了。
 *
 * 标题要做归一化：ME 新建节点的占位是 `New Node`（ME 的构造函数里
 * `newTopicName: ''` 是 falsy，会退回默认文案），而我们这边空标题渲染成
 * `未命名` —— 不归一化的话两者永远对不上，每次新建节点都会重画一次。
 *
 * 签名必须带上 tags：之前只比 id + 标题 + 结构，
 * 改关联人（@chip 渲染在 tags 里）这类不动标题的变更被判定为「一致」，
 * 画布永远不重画 —— 正确性优先于省一次 refresh。
 *
 * 注意只能比 ME 自己也会保留的字段（id / topic / children / tags）：
 * ME 新建节点的 metadata 是空的，把 metadata 算进签名会让
 * 「画布刚做完操作」的比对永远不一致 → 每次操作都全量重画，手感发涩。
 */
function treeSignature(node: BranchNode | undefined): string {
  if (!node) return ''
  const kids = node.children ?? []
  const visible = JSON.stringify(node.tags ?? [])
  return `${node.id ?? ''}~${normTopic(node.topic)}~${visible}(${kids.map(treeSignature).join(',')})`
}

function normTopic(topic: string | undefined): string {
  const v = (topic ?? '').trim()
  return v === '' || v === 'New Node' ? '未命名' : v
}

/** 由应用层统一实现的键（避免 ME 内建键位重复触发） */
const APP_KEYS = new Set(['Tab', 'Enter', 'F2', 'Delete', 'Backspace'])

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** 快捷键清单：画布右下角小面板直接渲染这份表，语义与实现同源 */
const SHORTCUT_ROWS: { keys: string[]; desc: string; leaf?: boolean }[] = [
  { keys: ['Tab'], desc: '新增子节点' },
  { keys: ['Enter'], desc: '新增兄弟节点' },
  { keys: ['⇧', 'Tab'], desc: '提升一级' },
  { keys: ['⌥', 'Tab'], desc: '降低一级（挂到上一个同级下）' },
  { keys: ['⌥', '↑'], desc: '同级上移一位' },
  { keys: ['⌥', '↓'], desc: '同级下移一位' },
  { keys: ['F2'], desc: '编辑标题（也可双击）' },
  { keys: ['⌫'], desc: '删除节点（可撤销）' },
  { keys: ['Space'], desc: '完成 / 取消完成', leaf: true },
  { keys: ['⌘', 'T'], desc: '加入 Today', leaf: true },
  { keys: ['⌘', 'Z'], desc: '撤销上一步' },
  { keys: ['⌘', ']'], desc: '下一张图' },
  { keys: ['⌘', '['], desc: '上一张图' },
]

function keyLabel(k: string): string {
  if (k === '⌘') return mod()
  if (k === '⇧') return IS_MAC ? '⇧' : 'Shift'
  if (k === '⌥') return IS_MAC ? '⌥' : 'Alt'
  return k
}

/**
 * ME 的 findEle 找不到节点时是**抛异常**（"FindEle: Node x not found, maybe it's
 * collapsed"），不是返回 null。节点完成 / 删除后会被折进折叠的「已完成」组，
 * 此时必须兜住 —— 否则画布组件崩溃，页面被 ErrorBoundary 吞掉，
 * 快捷键（含 ⌘Z 撤销）随之全部失灵。
 */
function findEleSafe(mei: MindElixirInstance | null, id: string): unknown {
  try {
    return mei?.findEle?.(id)
  } catch {
    return undefined
  }
}

export default function MindmapCanvas({ rootId, mapIds, onSelectMap }: MindmapCanvasProps): JSX.Element {
  const elRef = useRef<HTMLDivElement>(null)
  const meiRef = useRef<MindElixirInstance | null>(null)
  const coachTimer = useRef<number | null>(null)
  const [coach, setCoach] = useState<string | null>(null)
  const [showKeys, setShowKeys] = useState(false)
  const [ready, setReady] = useState(0)
  /** 当前选中的节点（驱动底部操作栏）；编辑态用于隐藏操作栏 */
  const [selectedId, setSelectedId] = useState<ID | null>(null)
  const [editingUi, setEditingUi] = useState(false)
  /** 选中态的 ref 镜像：ME 的 click 监听器 mount 时注册一次，闭包拿不到最新 state */
  const selectedRef = useRef<ID | null>(null)
  selectedRef.current = selectedId
  const todos = useAllTodos()
  const focusId = useUI((s) => s.todoFocusId)

  /**
   * 最新 todos 快照。
   * ME 的 operation 监听器在 mount 时注册一次（effect deps 只有 rootId），
   * 直接闭包捕获 todos 会永远拿到初始的空数组 → byId 为空 →
   * removeNodes / moveNodes* 的补丁被整段跳过，结构操作不落库。
   */
  const todosRef = useRef(todos)
  todosRef.current = todos

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

  /**
   * F-09 · 画布自适应。
   *
   * ME 默认按**根节点**居中（toCenter），树会整体偏在右下角、跟画布重心脱节；
   * 而画布比树窄时（右侧被 Today 托盘挤过），树的右半边直接被切掉看不见。
   * scaleFit() 按**整棵树**的包围盒居中，并在内容超出画布时自动缩小。
   */
  const fitToView = useCallback((): void => {
    const mei = meiRef.current
    if (!mei?.scaleFit) return
    // 等 ME 的布局算完再量，否则量到的是上一帧的尺寸
    requestAnimationFrame(() => {
      try {
        mei.scaleFit?.()
      } catch {
        /* 布局未就绪：下一帧再试 */
      }
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    let editObserver: MutationObserver | null = null
    ;(async () => {
      const MindElixir = (await import('mind-elixir')).default
      await import('mind-elixir/style.css')
      if (cancelled || !elRef.current) return
      const mei = new MindElixir({
        el: elRef.current,
        direction: 1,
        editable: true,
        toolBar: false,
        // 右键菜单保持关闭：ME 自带的「插入父节点 / 连接 / 专注」
        // 语义与我们的数据模型对不上，发现入口由底部操作栏承担
        contextMenu: false,
        allowUndo: false,
        newTopicName: '',
        // F-09 · 用有机树枝替换 ME 默认的「折线 + 直线段」
        // （必须挂在 theme 上：ME 的 setTheme 会用 theme.generateMainBranch
        //   覆盖构造函数的同名选项）
        theme: {
          name: 'Minimal',
          type: 'light',
          palette: MINIMAL_PALETTE,
          generateMainBranch: organicMainBranch,
          generateSubBranch: organicSubBranch,
        },
      }) as unknown as MindElixirInstance
      const data = todosToMindData(todos, rootId)
      await mei.init(data)
      fitToView()

      // F-02 · 键位语义统一由应用层实现（见 SHORTCUT_ROWS）：
      // 把 ME 内建的 Tab/Enter/删除/编辑接管过来，避免同一动作触发两次。
      const container = mei.container
      const orig = container?.onkeydown
      if (container && orig) {
        container.onkeydown = (e: KeyboardEvent) => {
          // ⌥↑/⌥↓ 是应用层的「同级排序」，ME 会把 ArrowUp/Down 当选中导航
          if (APP_KEYS.has(e.key) || (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) {
            e.preventDefault()
            return
          }
          orig.call(container, e)
        }
      }

      /**
       * 双击节点 → 直接进编辑。
       *
       * ME v6 的 map 视图没有 dblclick 处理，它靠「再点一次已选中的节点」
       * 进编辑态。于是「双击一个还没选中的节点」经常不生效（第二次点击
       * 到达时选中态还没生效）—— 实测：Tab 加完节点后再双击改名就失灵。
       * 官方文档里「双击节点直接编辑」是承诺的行为，这里补回来。
       */
      container?.addEventListener('dblclick', (e: Event) => {
        // 已经在编辑了就别再开一个
        if (document.querySelector('#input-box')) return
        const tpc = (e.target as HTMLElement | null)?.closest?.(
          '.me-tpc',
        ) as (HTMLElement & { nodeObj?: { id?: string } }) | null
        if (!tpc?.nodeObj) return
        // 合成节点（「已完成 (N)」这类）不是真待办，不能进编辑
        if (String(tpc.nodeObj.id ?? '').startsWith('done-group:')) return
        e.preventDefault()
        e.stopPropagation()
        void mei.editTopic?.(tpc)
      })

      /**
       * 单击即改（与列表 / 今天页的行内编辑同口径）：
       * 第一击选中节点（操作栏出现），再点一下已选中的节点 = 进编辑。
       * 关键坑：ME 的选中是在同一次 click 里先发生的 —— 直接在 click 里
       * 比选中态会把「第一击」也当成「再点一下」。所以用 pointerdown 的
       * 捕获阶段快照「按下之前选的是谁」，click 时和快照比。
       */
      let selAtDown: string | null = null
      /** 首次拖动教学：记录按下点，拖出阈值后教一次落点语义 */
      let downPos: { x: number; y: number; onTopic: boolean } | null = null
      let dragHintArmed =
        typeof localStorage !== 'undefined' &&
        !localStorage.getItem('mindmap_drag_hint_v1')
      container?.addEventListener(
        'pointerdown',
        (e: Event) => {
          selAtDown = selectedRef.current
          const ev = e as PointerEvent
          const tpc = (ev.target as HTMLElement | null)?.closest?.('.me-tpc')
          downPos = { x: ev.clientX, y: ev.clientY, onTopic: Boolean(tpc) }
        },
        { capture: true },
      )
      container?.addEventListener(
        'pointermove',
        (e: Event) => {
          if (!downPos?.onTopic || !dragHintArmed) return
          const ev = e as PointerEvent
          if (Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) < 10) return
          dragHintArmed = false
          localStorage.setItem('mindmap_drag_hint_v1', '1')
          say('拖到节点上 = 变成它的子节点；拖到上 / 下边缘 = 排到它前面 / 后面')
        },
        { capture: true, passive: true },
      )
      container?.addEventListener(
        'pointerup',
        () => {
          downPos = null
        },
        { capture: true },
      )
      container?.addEventListener('click', (e: Event) => {
        if (document.querySelector('#input-box')) return
        const tpc = (e.target as HTMLElement | null)?.closest?.(
          '.me-tpc',
        ) as (HTMLElement & { nodeObj?: { id?: string } }) | null
        if (!tpc?.nodeObj) return
        const id = String(tpc.nodeObj.id ?? '')
        if (id.startsWith('done-group:')) return
        if (id && id === selAtDown) {
          e.preventDefault()
          void mei.editTopic?.(tpc)
        }
      })

      mei.bus.addListener('operation', (payload: unknown) => {
        const ev = payload as MeOperation
        // 编辑态唯一事实源在 undoStack（isMindmapEditing），这里只负责同步
        if ((ev as { name?: string }).name === 'beginEdit') {
          setMindmapEditing(true)
          setEditingUi(true)
          return
        }
        if (ev.name === 'finishEdit') {
          setMindmapEditing(false)
          setEditingUi(false)
        }
        const byId = new Map(todosRef.current.map((t) => [t.id, t]))
        const ops = mindEventToTodoPatches(ev, { all: todosRef.current, mapId: rootId, byId })
        void applyTodoPatches(ops, { scope: rootId })
      })
      /**
       * Escape 退出编辑时 ME v6 不会发 finishEdit —— 编辑框直接被移除，
       * editingUi 会永远卡住（操作栏再也不出现）。统一以「#input-box 从
       * DOM 消失」作为编辑结束的兜底信号；finishEdit 先到时这里只是
       * 幂等地再清一次。
       */
      editObserver = new MutationObserver(() => {
        if (document.querySelector('#input-box')) return
        if (isMindmapEditing()) {
          setMindmapEditing(false)
          setEditingUi(false)
        }
      })
      editObserver.observe(mei.container ?? elRef.current!, {
        childList: true,
        subtree: true,
      })

      // 选中态 → 底部操作栏：鼠标党不用背快捷键也能增删节点
      mei.bus.addListener('selectNewNode', (node: unknown) => {
        setSelectedId((node as { id?: string } | null)?.id ?? null)
      })
      mei.bus.addListener('selectNodes', (nodes: unknown) => {
        const arr = nodes as Array<{ id?: string }>
        setSelectedId(arr.length === 1 ? (arr[0]?.id ?? null) : null)
      })
      mei.bus.addListener('unselectNodes', () => setSelectedId(null))
      meiRef.current = mei
      setSelectedId(mei.currentNode?.nodeObj?.id ?? null)
      // ME 是异步建的：数据可能早于它到位，置 ready 让下面的重绘补一次
      setReady((n) => n + 1)
    })()
    return () => {
      cancelled = true
      editObserver?.disconnect()
      editObserver = null
      meiRef.current?.destroy?.()
      meiRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId])

  useEffect(() => {
    const mei = meiRef.current
    if (!mei || isMindmapEditing()) return
    const data = todosToMindData(todos, rootId)
    /**
     * 渲染结果没变就别重画。
     *
     * refresh 会重建 ME 的整棵 DOM（清掉选中态、吞掉进行中的点击 / 双击）。
     * 而像「Inbox 根图创建」这种**与本图无关**的 DB 变更也会触发 todos 变化，
     * 于是画布被无谓地重画一次 —— 双击恰好落在那个窗口里就会丢。
     * 哈希取的是真正要渲染的那棵树（含 metadata），比按 todo 字段拼更准。
     */
    const hash = JSON.stringify(data)
    const prev = mei as MindElixirInstance & { __hash?: string }
    if (prev.__hash === hash) return
    /**
     * ME 刚在画布上做完操作（加节点 / 移动 / 改名），数据也同步回 Dexie 了 ——
     * 这时候画布**已经是最新**的，再按 Dexie refresh 一次只会：
     *   ① 重建整棵 DOM（ME 的动画没了、选中态闪一下）
     *   ② 把正在进行的点击 / 双击吞掉
     * 所以先比一下「画布上现在的树」和「Dexie 要画的树」，一致就不画。
     */
    const meSig = treeSignature(readMeNode(mei))
    const ourSig = treeSignature(data.nodeData)
    if (meSig && meSig === ourSig) {
      prev.__hash = hash
      return
    }
    prev.__hash = hash
    if (typeof mei.refresh === 'function') {
      // refresh 会清空选中态；把原选中的节点选回来，连按快捷键才不断
      const keepId = mei.currentNode?.nodeObj?.id
      mei.refresh(data)
      if (keepId) {
        const el = findEleSafe(mei, keepId)
        if (el) {
          mei.selectNode?.(el)
          setSelectedId(keepId)
        }
      }
      fitToView()
    } else {
      void mei.init(data)
      fitToView()
    }
  }, [todos, rootId, ready, fitToView])

  useEffect(() => {
    if (!focusId || !meiRef.current) return
    const el = findEleSafe(meiRef.current, focusId)
    if (el) meiRef.current.selectNode?.(el, true)
    useUI.setState({ todoFocusId: null })
  }, [focusId])

  /** 画布拿到焦点，ME 的方向键 / 缩放等内建键位才生效 */
  const focusCanvas = useCallback((): void => {
    meiRef.current?.container?.focus?.({ preventScroll: true })
  }, [])

  // 画布尺寸变了（窗口缩放 / 侧栏折叠）就重新自适应
  useEffect(() => {
    const el = elRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => fitToView())
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitToView])

  /** F-02 · 切图：⌘] / ⌘[ 在图库面板里前后翻 */
  /**
   * F-02 · ⌘] / ⌘[ 切图。
   *
   * 原来是「找到左侧图库面板里的按钮，替用户点一下」—— 靠 DOM 结构猜，
   * 图库一改成浮层就断了。现在图库把「有序的图 id 列表 + 选中回调」透进来，
   * 键盘直接切，DOM 长什么样都不影响。
   */
  const switchMap = useCallback(
    (dir: 1 | -1): void => {
      const ids = mapIds ?? []
      if (ids.length <= 1) {
        say('只有一张图 —— 在左上角切图入口新建')
        return
      }
      const idx = ids.findIndex((id) => id === rootId)
      const next = ids[(idx + dir + ids.length) % ids.length]
      if (!next || !onSelectMap) return
      onSelectMap(next)
    },
    [mapIds, onSelectMap, rootId, say],
  )

  /** 选中节点 / 空图判断用的父索引（操作栏与键盘共用） */
  const byParentAll = useMemo(() => indexByParent(todos), [todos])
  const selectedTodo = useMemo(
    () => (selectedId ? todos.find((x) => x.id === selectedId) : undefined),
    [todos, selectedId],
  )

  /** 完成 / 取消完成（键盘 Space 与操作栏共用一条路径） */
  const toggleDone = useCallback(
    async (t: Todo): Promise<void> => {
      if (!isLeafTodo(t, byParentAll)) {
        say('结构节点不能直接完成 —— 按 Tab 拆成一步再完成')
        return
      }
      const todayBefore = await getToday()
      pushTodoStatusUndo(t.id, t.status, rootId, todayBefore)
      await applyTodoStatus(t, t.status === 'done' ? 'open' : 'done')
    },
    [byParentAll, rootId, say],
  )

  /** 入 Today（键盘 ⌘T 与操作栏共用一条路径） */
  const addToday = useCallback(
    async (t: Todo): Promise<void> => {
      if (!todayEligible(t, byParentAll)) {
        const msg = t.waiting_reason
          ? 'Waiting 不能入 Today，先清除原因或拆步'
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

  /** 删除节点（键盘 ⌫ 与操作栏共用一条路径） */
  const removeNode = useCallback(
    (t: Todo): void => {
      const mei = meiRef.current
      if (!mei) return
      if (t.id === rootId) {
        say('根节点不能删除')
        return
      }
      const el = findEleSafe(mei, t.id)
      if (el) void mei.removeNodes?.([el])
    },
    [rootId, say],
  )

  /** 空图引导：选中根节点并直接加第一个子节点 */
  const startFirstNode = useCallback((): void => {
    const mei = meiRef.current
    if (!mei) return
    const el = findEleSafe(mei, rootId)
    if (el) mei.selectNode?.(el, true)
    void mei.addChild?.()
  }, [rootId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mei = meiRef.current
      if (!mei) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (isMindmapEditing()) return

      const isMod = e.metaKey || e.ctrlKey

      // 切图不依赖选中节点
      if (isMod && (e.key === ']' || e.key === '[')) {
        e.preventDefault()
        switchMap(e.key === ']' ? 1 : -1)
        return
      }

      const node = mei.currentNode?.nodeObj
      if (!node || node.id.startsWith('done-group:')) return
      const byParent = indexByParent(todos)
      const t = todos.find((x) => x.id === node.id)
      if (!t) return

      // Space：完成 / 取消完成（R1 · 仅叶子）
      if (e.code === 'Space') {
        e.preventDefault()
        void toggleDone(t)
        return
      }

      // ⌘T：入 Today（R1 · 仅叶子 + open + 无 Waiting）
      if (isMod && e.key.toLowerCase() === 't') {
        e.preventDefault()
        void addToday(t)
        return
      }

      // ⌥↑ / ⌥↓：同级上移 / 下移一位（排序，不换父级。
      // 拖拽的上下边缘落点太细，键盘给一条确定的路径）
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        if (t.id === rootId) {
          say('根节点不能移动')
          return
        }
        const parent = t.parent_id ? todos.find((x) => x.id === t.parent_id) : undefined
        if (parent?.status === 'done') {
          say('已完成分组里不支持排序')
          return
        }
        const sibs = (byParent.get(t.parent_id) ?? [])
          .filter((s) => s.status !== 'done')
          .sort((a, b) => a.sort_order - b.sort_order)
        const idx = sibs.findIndex((s) => s.id === t.id)
        const dir = e.key === 'ArrowUp' ? -1 : 1
        const neighbor = sibs[idx + dir]
        if (!neighbor) {
          say(dir === -1 ? '已经是第一个了' : '已经是最后一个了')
          return
        }
        const from = findEleSafe(mei, t.id)
        const to = findEleSafe(mei, neighbor.id)
        if (from && to) {
          if (dir === -1) void mei.moveNodesBefore?.([from], to)
          else void mei.moveNodesAfter?.([from], to)
        }
        return
      }

      // 层级：Tab 加子节点 / ⇧Tab 提升 / ⌥Tab 降低
      if (e.key === 'Tab') {
        e.preventDefault()
        const parent = t.parent_id ? todos.find((x) => x.id === t.parent_id) : undefined
        if (parent?.status === 'done') {
          say('已完成分组里不支持调整层级')
          return
        }
        if (e.shiftKey) {
          if (!t.parent_id || t.parent_id === rootId) {
            say('已经是最外层了')
            return
          }
          const from = findEleSafe(mei, t.id)
          const to = findEleSafe(mei, t.parent_id)
          if (from && to) void mei.moveNodesAfter?.([from], to)
          return
        }
        if (e.altKey) {
          // 挂到「上一个可见同级」下（画布上 done 节点在折叠组里，不算同级）
          const sibs = (byParent.get(t.parent_id) ?? [])
            .filter((s) => s.status !== 'done')
            .sort((a, b) => a.sort_order - b.sort_order)
          const idx = sibs.findIndex((s) => s.id === t.id)
          const prevSib = idx > 0 ? sibs[idx - 1] : undefined
          if (!prevSib) {
            say('已经是第一个同级 —— 没有更上一层可挂')
            return
          }
          const from = findEleSafe(mei, t.id)
          const to = findEleSafe(mei, prevSib.id)
          if (from && to) void mei.moveNodesIn?.([from], to)
          return
        }
        void mei.addChild?.()
        return
      }

      // Enter：新增兄弟节点（⇧Enter 插到前面）；⌘Enter / F2：编辑
      if (e.key === 'Enter') {
        e.preventDefault()
        if (isMod) {
          void mei.beginEdit?.()
          return
        }
        if (t.id === rootId) {
          say('根节点没有兄弟节点 —— 按 Tab 加子节点')
          return
        }
        void mei.insertSibling?.(e.shiftKey ? 'before' : 'after')
        return
      }
      if (e.key === 'F2') {
        e.preventDefault()
        void mei.beginEdit?.()
        return
      }

      // 删除：软删子树，业务 ⌘Z 可撤销
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        removeNode(t)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [todos, rootId, say, switchMap, toggleDone, addToday, removeNode])

  const isDoneGroupSel = Boolean(selectedId?.startsWith('done-group:'))
  const rootKids = byParentAll.get(rootId) ?? []
  const showActionBar = Boolean(selectedTodo && !editingUi && !isDoneGroupSel)

  return (
    <div className="mindmap-wrap relative w-full h-full min-h-[420px]" onMouseDown={focusCanvas}>
      {/* 教练提示常驻挂载、用 visibility 切显隐 —— 这样消失时能淡出，
          而不是「啪」地没了（内容为空时对读屏无影响）。 */}
      <div className="mindmap-coach" role="status" data-show={coach ? '1' : '0'}>
        {coach ?? ''}
      </div>
      <div ref={elRef} className="mindmap-canvas w-full h-full min-h-[420px]" />

      {/* 空图引导：不给用户一面空白画布去猜 */}
      {rootKids.length === 0 && (
        <div className="mindmap-empty">
          <div className="mindmap-empty-title">这张图还是空的</div>
          <button type="button" className="mindmap-empty-btn" onClick={startFirstNode}>
            ＋ 添加第一条任务
          </button>
          <div className="mindmap-empty-hint">
            之后选中任意节点，底部会出现操作栏（也可以按 Tab 继续拆）
          </div>
        </div>
      )}

      {/* 选中节点的操作栏：增删节点不用背快捷键（按钮上也标了键位，顺手教学） */}
      {showActionBar && selectedTodo && (
        <div className="mindmap-actionbar" role="toolbar" aria-label="节点操作">
          <button type="button" onClick={() => void meiRef.current?.addChild?.()}>
            ＋ 子节点 <kbd className="mindmap-kbd">Tab</kbd>
          </button>
          <button
            type="button"
            disabled={selectedTodo.id === rootId}
            onClick={() => void meiRef.current?.insertSibling?.('after')}
          >
            ＋ 同级 <kbd className="mindmap-kbd">{IS_MAC ? '⏎' : 'Enter'}</kbd>
          </button>
          <button type="button" onClick={() => void meiRef.current?.beginEdit?.()}>
            ✎ 改名 <kbd className="mindmap-kbd">F2</kbd>
          </button>
          <button
            type="button"
            disabled={!isLeafTodo(selectedTodo, byParentAll)}
            title={
              !isLeafTodo(selectedTodo, byParentAll)
                ? '结构节点不能直接完成 —— 先拆成一步'
                : undefined
            }
            onClick={() => void toggleDone(selectedTodo)}
          >
            {selectedTodo.status === 'done' ? '取消完成' : '✓ 完成'}{' '}
            <kbd className="mindmap-kbd">Space</kbd>
          </button>
          <button
            type="button"
            disabled={!todayEligible(selectedTodo, byParentAll)}
            onClick={() => void addToday(selectedTodo)}
          >
            ☼ 入 Today <kbd className="mindmap-kbd">{mod()}T</kbd>
          </button>
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
      {/* F-02 · 轻量提示：默认只有一个角标，点开才是清单（R5 · 不堆画布噪点） */}
      <div className="mindmap-hint">
        {showKeys && (
          <div className="mindmap-hint-panel" role="menu" aria-label="脑图快捷键">
            <div className="mindmap-hint-title">鼠标</div>
            <div className="mindmap-hint-row">
              <span className="mindmap-hint-desc">单击节点：选中，底部出操作栏</span>
            </div>
            <div className="mindmap-hint-row">
              <span className="mindmap-hint-desc">再点一下（或双击）：改名</span>
            </div>
            <div className="mindmap-hint-row">
              <span className="mindmap-hint-desc">拖拽节点：换父级 / 调整顺序</span>
            </div>
            <div className="mindmap-hint-row">
              <span className="mindmap-hint-desc">节点里写「@张三 明天」：自动识别负责人和截止</span>
            </div>
            <div className="mindmap-hint-title">快捷键</div>
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
        <button
          type="button"
          className="mindmap-hint-btn"
          aria-expanded={showKeys}
          onClick={() => setShowKeys((v) => !v)}
        >
          快捷键
        </button>
      </div>
    </div>
  )
}
