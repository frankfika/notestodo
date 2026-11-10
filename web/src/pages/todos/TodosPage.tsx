import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { now, uid } from '../../lib/id'
import { useUI } from '../../state/ui'
import TodosTree from './TodosTree'
import TodosList from './TodosList'
import MindmapCanvas from './MindmapCanvas'
import { buildTagByTodo, EMPTY_FILTER, type TodoFilter } from './filter'
import { parseQuickAdd } from '../../lib/quickAdd'
import DateInput from '../../components/DateInput'
import { getFeatures } from '../../lib/features'
import { listMapRoots } from '../../lib/mindmap/mapRoots'
import { isMindmapEditing, undoMindmap } from '../../lib/mindmap/undoStack'
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
  const mindmapEnabled = useLiveQuery(async () => (await getFeatures()).mindmap_tasks, []) ?? false
  const [tab, setTab] = useState<ViewTab>('list')
  const goBoard = useUI((s) => s.goBoard)
  const [filter, setFilter] = useState<TodoFilter>(EMPTY_FILTER)
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')
  const roots = useLiveQuery(listMapRoots, []) ?? []
  const [rootId, setRootId] = useState<string | null>(null)
  /** 有序的图根 id（脑图 ⌘] / ⌘[ 切图用） */
  const mapIds = useMemo(() => roots.map((r) => r.id), [roots])

  useEffect(() => {
    if (mindmapEnabled && tab !== 'mindmap') setTab('mindmap')
    if (!mindmapEnabled && tab === 'mindmap') setTab('list')
  }, [mindmapEnabled]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!rootId && roots[0]) setRootId(roots[0].id)
  }, [roots, rootId])

  useEffect(() => {
    if (tab !== 'mindmap' || !mindmapEnabled) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        return
      }
      if (isMindmapEditing()) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        void undoMindmap()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tab, mindmapEnabled])

  const tags = useLiveQuery(() => db.tags.orderBy('name').toArray(), []) ?? []
  const bindings = useLiveQuery(() => db.tagBindings.toArray(), []) ?? []
  const tagByTodo = useMemo(() => buildTagByTodo(bindings), [bindings])

  const addQuick = async (): Promise<void> => {
    const raw = newTitle.trim()
    if (!raw) return
    const parsed = parseQuickAdd(raw)
    const ts = now()
    const id = uid()
    await db.todos.add({
      id,
      kind: 'task',
      parent_id: null,
      scope: null,
      title: parsed.title,
      status: 'open',
      source: 'manual',
      sort_order: Date.now(),
      map_id: id,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
      ...(parsed.assignee ? { assignee: parsed.assignee } : {}),
      ...(newDue || parsed.due_date ? { due_date: newDue || parsed.due_date! } : {}),
    })
    setNewTitle('')
    setNewDue('')
  }

  const toggleTag = (id: string): void =>
    setFilter((f) => ({
      ...f,
      tagIds: f.tagIds.includes(id) ? f.tagIds.filter((x) => x !== id) : [...f.tagIds, id],
    }))

  const viewTabs = mindmapEnabled
    ? ([['mindmap', '脑图'], ['tree', '大纲'], ['list', '按时间']] as const)
    : ([['list', '列表'], ['tree', '大纲']] as const)

  return (
    <div className="h-full flex flex-col">
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
          <span className="ml-2 text-xs text-text-3">在左侧图库选择或新建图</span>
        )}
        <div className="flex-1" />
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
      </div>

      <div className="flex items-center gap-2 px-4 py-2 border-b border-line shrink-0">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') void addQuick()
          }}
          placeholder="＋ 添加任务，回车创建（支持「明天 交方案 @张三」）"
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
                <MindmapCanvas rootId={rootId} mapIds={mapIds} onSelectMap={setRootId} />
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
            <TodosTree filter={filter} tagByTodo={tagByTodo} readOnly={mindmapEnabled} />
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
