import { type JSX, useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import TodosTree from './TodosTree'
import TodosList from './TodosList'
import MindmapCanvas from './MindmapCanvas'
import { buildTagByTodo, EMPTY_FILTER, type TodoFilter } from './filter'
import { parseQuickAdd } from '../../lib/quickAdd'
import { subtreeIds } from '../../lib/okr'
import DateInput from '../../components/DateInput'
import { getFeatures } from '../../lib/features'
import { createTask } from '../../lib/mindmap/createTask'
import { ensureInboxMap, listMapRoots } from '../../lib/mindmap/mapRoots'
import {
  canUndoMindmap,
  isMindmapEditing,
  peekMindmapUndoLabel,
  pushMindmapUndo,
  undoMindmap,
} from '../../lib/mindmap/undoStack'
import { useAllTodos } from '../../lib/useAllTodos'
import { useToast } from '../../state/toast'
import MapSwitcher from './MapSwitcher'
import InboxDrawer from './InboxDrawer'
import { TodayIndicator, TodaySwapPrompt } from './TodaySlots'

const STATUS_TABS = [
  ['active', '进行中'],
  ['done', '已完成'],
  ['archived', '已归档'],
  ['all', '全部'],
] as const

type ViewTab = 'mindmap' | 'tree' | 'list'

/**
 * 任务页：列表（按时间分组）+ 大纲（嵌套树）；mindmap_tasks 开启时
 * 默认脑图 Tab（画布优先：图库 / Inbox 收成左上角浮层，Today 挪去「今天」页）。
 * 看板在独立路由 board。
 */
export default function TodosPage(): JSX.Element {
  // 默认开：查询还没回来时先按脑图渲染，避免首帧闪一下经典列表
  const mindmapEnabled = useLiveQuery(async () => (await getFeatures()).mindmap_tasks, []) ?? true
  const [tab, setTab] = useState<ViewTab>('list')
  const goBoard = useUI((s) => s.goBoard)
  const [filter, setFilter] = useState<TodoFilter>(EMPTY_FILTER)
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')
  const roots = useLiveQuery(listMapRoots, []) ?? []
  const [rootId, setRootId] = useState<string | null>(null)
  /** 画布选中节点：快速添加的落点由它决定（选中 → 挂到它下面；未选中 → 图根一级分支） */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  /** 脑图沉浸模式：进入后画布吃满整屏；Esc 或 ✕ 退出 */
  const [fullscreen, setFullscreen] = useState(false)
  /** 选中节点与画布共用同一份 todos 订阅（同步派生）。
   *  之前按 selectedNodeId 单查一次库，选中后要等 liveQuery 回来，
   *  快速添加的占位文案会短暂还写着上一个节点。 */
  const allTodos = useAllTodos()
  const selectedTodo = useMemo(
    () => allTodos.find((t) => t.id === selectedNodeId),
    [allTodos, selectedNodeId],
  )
  const show = useToast((s) => s.show)
  /** 有序的图根 id（脑图 ⌘] / ⌘[ 切图用） */
  const mapIds = useMemo(() => roots.map((r) => r.id), [roots])
  /** 图根 id → 图名（跨图选中时报落点用） */
  const mapTitleById = useMemo(
    () => new Map(roots.map((r) => [r.id, r.title] as const)),
    [roots],
  )

  useEffect(() => {
    if (mindmapEnabled && tab !== 'mindmap') setTab('mindmap')
    if (!mindmapEnabled && tab === 'mindmap') setTab('list')
  }, [mindmapEnabled]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!rootId && roots[0]) setRootId(roots[0].id)
  }, [roots, rootId])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  // 沉浸态下切走视图 → 退出按钮不再渲染，页面却还被 fixed 遮着。
  // 跟着 tab 收起，避免「进得去出不来」。
  useEffect(() => {
    if (tab !== 'mindmap') setFullscreen(false)
  }, [tab])

  // 应用撤销：输入框聚焦时也生效（快速添加后焦点就在输入框）。
  // 只在栈里有本 scope 的条目时拦截原生文本撤销 —— 空栈时把 ⌘Z 还给浏览器。
  const undoScope = selectedTodo?.map_id ?? rootId ?? undefined
  useEffect(() => {
    if (!mindmapEnabled) return
    const onKey = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey)) return
      // 节点编辑中的 ⌘Z 交给 ME 自己处理
      if (isMindmapEditing()) return
      const el = e.target as HTMLElement | null
      const inField = Boolean(
        el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable),
      )
      if (canUndoMindmap(undoScope)) {
        e.preventDefault()
        const label = peekMindmapUndoLabel(undoScope)
        void undoMindmap(undoScope)
        show(label ? `已撤销「${label}」` : '已撤销')
        return
      }
      if (inField) return // 空栈：普通文本撤销照常工作
      e.preventDefault()
      show('没有可撤销的操作')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mindmapEnabled, undoScope, show])

  const tags = useLiveQuery(() => db.tags.orderBy('name').toArray(), []) ?? []
  const bindings = useLiveQuery(() => db.tagBindings.toArray(), []) ?? []
  const tagByTodo = useMemo(() => buildTagByTodo(bindings), [bindings])

  const addQuick = async (): Promise<void> => {
    const raw = newTitle.trim()
    if (!raw) return
    const parsed = parseQuickAdd(raw)
    // 脑图模式下快速添加的落点跟「选中」走（所见即所得）：
    //   选中了节点 → 挂到它下面；没选中 → 图根的一级分支；
    //   还没有图时用 Inbox 做第一张画布。
    // Inbox 捕获流另有 InboxDrawer 和本机 API 入口。经典模式仍建无父根任务。
    const mapId = mindmapEnabled ? (rootId ?? (await ensureInboxMap()).id) : null
    // 落点跟「选中」走（所见即所得）：选中 → 挂到它下面；没选中 → 图根一级分支。
    // 大纲是跨图视图：选中行属于别的图时，落点跟到那张图上（不再猜当前图）。
    const sel =
      mindmapEnabled && selectedTodo && !selectedNodeId?.startsWith('done-group:')
        ? selectedTodo
        : undefined
    const targetMapId = sel ? (sel.map_id ?? sel.id) : mapId
    const todo = await createTask({
      title: parsed.title,
      placement:
        sel && targetMapId
          ? { parentId: sel.id, mapId: targetMapId }
          : mapId
            ? { mapId }
            : { root: true },
      dueDate: newDue || parsed.due_date,
      assignee: parsed.assignee,
    })
    // 新任务上画布选中 —— 用户立刻看到「刚才那条加到哪了」
    if (targetMapId) useUI.setState({ todoFocusId: todo.id })
    // 与画布操作同口径：失败可撤（R4）
    pushMindmapUndo(async () => {
      const all = await db.todos.toArray()
      await db.todos.bulkDelete([...subtreeIds(todo.id, all)])
    }, '添加任务', targetMapId ?? 'global')
    setNewTitle('')
    setNewDue('')
  }

  const toggleTag = (id: string): void =>
    setFilter((f) => ({
      ...f,
      tagIds: f.tagIds.includes(id) ? f.tagIds.filter((x) => x !== id) : [...f.tagIds, id],
    }))

  // 输入框占位文案要报落点：选中节点 → 报节点名；选中行在别的图 → 带上图名，
  // 让「这条会落到哪张图」在跨图的大纲视图里一眼可见。
  const selTitle =
    selectedTodo && selectedTodo.title && !selectedNodeId?.startsWith('done-group:')
      ? selectedTodo.title.slice(0, 14)
      : ''
  const selMapTitle =
    mindmapEnabled &&
    selectedTodo &&
    selectedTodo.map_id &&
    selectedTodo.map_id !== rootId
      ? (mapTitleById.get(selectedTodo.map_id) ?? '')
      : ''

  const viewTabs = mindmapEnabled
    ? ([['mindmap', '脑图'], ['tree', '大纲'], ['list', '按时间']] as const)
    : ([['list', '列表'], ['tree', '大纲']] as const)

  return (
    <div
      className={`h-full flex flex-col${fullscreen ? ' fixed inset-0 z-50 bg-bg' : ''}`}
      data-testid={fullscreen ? 'todos-fullscreen' : undefined}
    >
      {/* 一行搞定：视图切换 + 搜索/筛选 */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-line shrink-0 flex-wrap">
        <div className="flex items-center gap-1">
          {viewTabs.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 h-8 rounded-[8px] text-sm transition-colors ${
                tab === k ? 'bg-bg-raise text-text-1 font-medium shadow-sm' : 'text-text-2 hover:bg-bg-overlay hover:text-text-1'
              }`}
            >{label}</button>
          ))}
          {!mindmapEnabled && (
            <button
              onClick={goBoard}
              className="px-3 h-8 rounded-[8px] text-sm text-text-2 hover:bg-bg-overlay hover:text-text-1 transition-colors"
            >看板</button>
          )}
        </div>
        {mindmapEnabled && !rootId && roots[0] && (
          <span className="ml-2 text-xs text-text-3">在左上角 ◱ 入口选择或新建图</span>
        )}
        {tab === 'mindmap' && (
          <button
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? '退出沉浸（Esc）' : '沉浸模式（Esc 退出）'}
            className="flex items-center gap-1 px-2.5 h-8 rounded-[8px] text-sm text-text-2 hover:bg-bg-overlay hover:text-text-1 transition-colors"
          >
            {fullscreen ? (
              '✕ 退出沉浸'
            ) : (
              <>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
                沉浸
              </>
            )}
          </button>
        )}
        <div className="flex-1" />
        {/* 搜索 / 状态 / 标签筛选只作用于大纲与列表 —— 脑图画布有自己的
            结构语义（done 折进折叠组、归档不出图），摆一排无效的控件只会吵 */}
        {tab !== 'mindmap' && (
          <>
            <input
              value={filter.q}
              onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
              placeholder="搜索…"
              className="input !h-7 w-32 text-xs"
            />
            <div className="flex items-center rounded-[8px] bg-bg-overlay p-0.5">
              {STATUS_TABS.map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setFilter((f) => ({ ...f, status: k }))}
                  className={`px-2.5 h-6 rounded-[6px] text-xs transition-colors ${
                    filter.status === k ? 'bg-bg-raise text-text-1 font-medium shadow-sm' : 'text-text-2 hover:text-text-1'
                  }`}
                >{label}</button>
              ))}
            </div>
            {tags.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {tags.map((t) => {
                  const on = filter.tagIds.includes(t.id)
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggleTag(t.id)}
                      className={`chip transition-colors ${on ? '!text-accent border-current' : 'opacity-60 hover:opacity-100'}`}
                    >#{t.name}</button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 px-4 py-2 border-b border-line shrink-0">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') void addQuick()
          }}
          placeholder={
            mindmapEnabled
              ? selTitle
                ? `＋ 添加到「${selMapTitle ? `${selMapTitle} › ` : ''}${selTitle}」下，回车创建（@人 / 明天 可识别）`
                : '＋ 添加为图的一级分支，回车创建（先选中节点则加在它下面）'
              : '＋ 添加任务，回车创建（支持「明天 交方案 @张三」）'
          }
          className="input !h-8 flex-1 min-w-0 text-sm"
        />
        <DateInput
          value={newDue}
          onChange={setNewDue}
          title="截止日期（可选）"
          className="input !h-8 !w-auto text-sm text-text-2 shrink-0"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'mindmap' && mindmapEnabled ? (
          /* 画布优先：图库 / Inbox / Today 都不再占常驻面板。
           * 之前 176 + 176 + 240 = 592px 的常驻面板，在 1280 的窗口里
           * 把画布挤到 456px —— 现在画布吃满整宽，面板按需浮起。 */
          <div className="h-full min-h-0 relative">
            {rootId ? (
              <div className="absolute inset-0">
                <MindmapCanvas
                  rootId={rootId}
                  mapIds={mapIds}
                  onSelectMap={setRootId}
                  selectedId={selectedNodeId}
                  onSelectionChange={setSelectedNodeId}
                />
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-text-3">
                选择一张进行中的图，或快速添加创建新图
              </div>
            )}

            {/* 左上角：切图 + Inbox 捕获 */}
            <div className="absolute top-3 left-3 z-30 flex items-start gap-2">
              <MapSwitcher rootId={rootId} onSelect={setRootId} />
              <InboxDrawer onOpenInboxMap={setRootId} />
            </div>

            {/* 右上角：Today（执行清单已挪到「今天」页，这里只留计数入口） */}
            <div className="absolute top-3 right-3 z-30 flex flex-col items-end gap-2">
              <TodayIndicator />
              <TodaySwapPrompt />
            </div>
          </div>
        ) : tab === 'tree' ? (
          <div className="h-full overflow-y-auto px-4 py-3">
            <TodosTree
              filter={filter}
              tagByTodo={tagByTodo}
              readOnly={mindmapEnabled}
              selectedId={mindmapEnabled ? selectedNodeId : undefined}
              onSelectRow={mindmapEnabled ? setSelectedNodeId : undefined}
            />
          </div>
        ) : (
          <div className="h-full overflow-y-auto px-4 py-3">
            <TodosList filter={filter} tagByTodo={tagByTodo} />
          </div>
        )}
      </div>
    </div>
  )
}
