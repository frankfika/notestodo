import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import {
  applyTodoPatches,
  mindEventToTodoPatches,
  todosToMindData,
} from '../../lib/mindmap/convert'
import { tryAddTodaySlot } from '../../lib/mindmap/todayBridge'
import { pushTodoStatusUndo, setMindmapEditing } from '../../lib/mindmap/undoStack'
import { indexByParent, isLeafTodo, todayEligible } from '../../lib/mindmap/leaf'
import { listMapRoots } from '../../lib/mindmap/mapRoots'
import type { MeOperation } from '../../lib/mindmap/types'
import type { ID, Todo } from '../../types'
import { mod, now } from '../../lib/id'
import './mindmap.css'

export type MindmapCanvasProps = {
  rootId: ID
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
  bus: { addListener: (ev: string, fn: (payload: MeOperation) => void) => void }
  findEle?: (id: string) => unknown
  selectNode?: (el: unknown, center?: boolean) => void
  currentNode?: { nodeObj?: { id: string } }
  container?: HTMLElement
  addChild?: () => Promise<void> | void
  insertSibling?: (type: 'before' | 'after') => Promise<void> | void
  beginEdit?: () => Promise<void> | void
  removeNodes?: (nodes: unknown[]) => Promise<void> | void
  moveNodesIn?: (from: unknown[], to: unknown) => Promise<void> | void
  moveNodesAfter?: (from: unknown[], to: unknown) => Promise<void> | void
  /** 缩放到刚好放得下 + 按整棵树居中 */
  scaleFit?: () => void
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
 * F-02 · 切图走图库面板的按钮（真相源仍在图库，键盘只是「代劳点击」）。
 * TODO(Fang): TodosPage 若能透出 onSelect，这里换成直接回调更干净。
 */
function clickLibraryMap(title: string): boolean {
  const lib = Array.from(document.querySelectorAll('aside')).find((a) =>
    a.textContent?.includes('图库'),
  )
  if (!lib) return false
  const btn = Array.from(lib.querySelectorAll('ul li button')).find(
    (b) => b.textContent?.trim() === title,
  )
  if (!(btn instanceof HTMLElement)) return false
  btn.click()
  return true
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

export default function MindmapCanvas({ rootId }: MindmapCanvasProps): JSX.Element {
  const elRef = useRef<HTMLDivElement>(null)
  const meiRef = useRef<MindElixirInstance | null>(null)
  const editingRef = useRef(false)
  const coachTimer = useRef<number | null>(null)
  const [coach, setCoach] = useState<string | null>(null)
  const [showKeys, setShowKeys] = useState(false)
  const [ready, setReady] = useState(0)
  const todos = useLiveQuery(() => db.todos.toArray(), []) ?? []
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
    ;(async () => {
      const MindElixir = (await import('mind-elixir')).default
      await import('mind-elixir/style.css')
      if (cancelled || !elRef.current) return
      const mei = new MindElixir({
        el: elRef.current,
        direction: 1,
        editable: true,
        toolBar: false,
        contextMenu: false,
        allowUndo: false,
        newTopicName: '',
        theme: { name: 'Minimal', type: 'light', palette: MINIMAL_PALETTE },
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
          if (APP_KEYS.has(e.key)) {
            e.preventDefault()
            return
          }
          orig.call(container, e)
        }
      }

      mei.bus.addListener('operation', (ev: MeOperation) => {
        if ((ev as { name?: string }).name === 'beginEdit') {
          editingRef.current = true
          setMindmapEditing(true)
          return
        }
        if (ev.name === 'finishEdit') {
          editingRef.current = false
          setMindmapEditing(false)
        }
        const byId = new Map(todosRef.current.map((t) => [t.id, t]))
        const ops = mindEventToTodoPatches(ev, { all: todosRef.current, mapId: rootId, byId })
        void applyTodoPatches(ops)
      })
      meiRef.current = mei
      // ME 是异步建的：数据可能早于它到位，置 ready 让下面的重绘补一次
      setReady((n) => n + 1)
    })()
    return () => {
      cancelled = true
      meiRef.current?.destroy?.()
      meiRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId])

  useEffect(() => {
    const mei = meiRef.current
    if (!mei || editingRef.current) return
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
    prev.__hash = hash
    if (typeof mei.refresh === 'function') {
      // refresh 会清空选中态；把原选中的节点选回来，连按快捷键才不断
      const keepId = mei.currentNode?.nodeObj?.id
      mei.refresh(data)
      if (keepId) {
        const el = findEleSafe(mei, keepId)
        if (el) mei.selectNode?.(el)
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
  const switchMap = useCallback(
    async (dir: 1 | -1): Promise<void> => {
      const roots = await listMapRoots()
      if (roots.length <= 1) {
        say('只有一张图 —— 在左侧图库新建')
        return
      }
      const idx = roots.findIndex((r) => r.id === rootId)
      const next = roots[(idx + dir + roots.length) % roots.length]
      if (!next) return
      if (!clickLibraryMap(next.title || '未命名')) say('切图失败 —— 请在左侧图库选择')
    },
    [rootId, say],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mei = meiRef.current
      if (!mei) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (editingRef.current) return

      const isMod = e.metaKey || e.ctrlKey

      // 切图不依赖选中节点
      if (isMod && (e.key === ']' || e.key === '[')) {
        e.preventDefault()
        void switchMap(e.key === ']' ? 1 : -1)
        return
      }

      const topic = mei.currentNode
      const node = topic?.nodeObj
      if (!node || node.id.startsWith('done-group:')) return
      const byParent = indexByParent(todos)
      const t = todos.find((x) => x.id === node.id)
      if (!t) return

      // Space：完成 / 取消完成（R1 · 仅叶子）
      if (e.code === 'Space') {
        e.preventDefault()
        if (!isLeafTodo(t, byParent)) {
          say('结构节点不能直接完成 —— 按 Tab 拆成一步再完成')
          return
        }
        const prev = t.status
        pushTodoStatusUndo(t.id, prev)
        void db.todos.update(t.id, {
          status: t.status === 'done' ? 'open' : 'done',
          updated_at: now(),
          sync_version: t.sync_version + 1,
        })
        return
      }

      // ⌘T：入 Today（R1 · 仅叶子 + open + 无 Waiting）
      if (isMod && e.key.toLowerCase() === 't') {
        e.preventDefault()
        if (!todayEligible(t, byParent)) {
          const msg = t.waiting_reason
            ? 'Waiting 不能入 Today，先清除原因或拆步'
            : !isLeafTodo(t, byParent)
              ? '先拆成一步（按 Tab 加子节点），再 ⌘T'
              : '当前节点不可入 Today'
          say(msg)
          return
        }
        setCoach(null)
        void tryAddTodaySlot(t.id, rootId)
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
        if (t.id === rootId) {
          say('根节点不能删除')
          return
        }
        void mei.removeNodes?.([topic])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [todos, rootId, say, switchMap])

  return (
    <div className="mindmap-wrap relative w-full h-full min-h-[420px]" onMouseDown={focusCanvas}>
      {coach && (
        <div className="mindmap-coach" role="status">
          {coach}
        </div>
      )}
      <div ref={elRef} className="mindmap-canvas w-full h-full min-h-[420px]" />
      {/* F-02 · 轻量提示：默认只有一个角标，点开才是清单（R5 · 不堆画布噪点） */}
      <div className="mindmap-hint">
        {showKeys && (
          <div className="mindmap-hint-panel" role="menu" aria-label="脑图快捷键">
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
