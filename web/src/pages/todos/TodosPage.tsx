import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { now, uid } from '../../lib/id'
import { useUI } from '../../state/ui'
import TodosTree from './TodosTree'
import TodosList from './TodosList'
import MindmapCanvas from './MindmapCanvas'
import TodayTray from './TodayTray'
import { buildTagByTodo, EMPTY_FILTER, type TodoFilter } from './filter'
import { parseQuickAdd } from '../../lib/quickAdd'
import DateInput from '../../components/DateInput'
import { getFeatures } from '../../lib/features'
import { listMapRoots } from '../../lib/mindmap/mapRoots'
import MapLibrary from './MapLibrary'

const STATUS_TABS = [
  ['active', '进行中'],
  ['done', '已完成'],
  ['all', '全部'],
] as const

type ViewTab = 'mindmap' | 'tree' | 'list'

/**
 * 任务页：纯嵌套任务树 + 时间分组列表（OKR 三层概念已从 UI 移除，
 * 数据层 kind/scope 字段保留兼容）。看板在独立路由 board。
 * mindmap_tasks 开启时默认脑图 Tab。
 */
export default function TodosPage(): JSX.Element {
  const mindmapEnabled = useLiveQuery(async () => (await getFeatures()).mindmap_tasks, []) ?? false
  const [tab, setTab] = useState<ViewTab>('tree')
  const goBoard = useUI((s) => s.goBoard)
  const [filter, setFilter] = useState<TodoFilter>(EMPTY_FILTER)
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')
  const roots = useLiveQuery(listMapRoots, []) ?? []
  const [rootId, setRootId] = useState<string | null>(null)
  const [mapLibOpen, setMapLibOpen] = useState(false)

  useEffect(() => {
    if (mindmapEnabled && tab === 'tree') setTab('mindmap')
    if (!mindmapEnabled && tab === 'mindmap') setTab('tree')
  }, [mindmapEnabled]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!rootId && roots[0]) setRootId(roots[0].id)
  }, [roots, rootId])

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
    : ([['tree', '树'], ['list', '按时间']] as const)

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-line shrink-0 flex-wrap">
        {viewTabs.map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 h-8 rounded-[8px] text-sm transition-colors ${
              tab === k ? 'bg-bg-raise text-text-1 font-medium shadow-sm' : 'text-text-2 hover:bg-bg-overlay hover:text-text-1'
            }`}
          >{label}</button>
        ))}
        {mindmapEnabled && (
          <button
            type="button"
            onClick={() => setMapLibOpen(true)}
            className="ml-2 px-2 h-8 rounded-[8px] text-sm text-text-2 hover:bg-bg-overlay"
          >
            图库
          </button>
        )}
        {mindmapEnabled && roots.length > 1 && (
          <select
            className="ml-1 text-sm input !h-8 !w-auto max-w-[12rem]"
            value={rootId ?? ''}
            onChange={(e) => setRootId(e.target.value)}
          >
            {roots.map((r) => (
              <option key={r.id} value={r.id}>{r.title || '未命名'}</option>
            ))}
          </select>
        )}
        {!mindmapEnabled && (
          <button
            onClick={goBoard}
            className="ml-auto px-3 h-8 rounded-[8px] text-sm text-text-2 hover:bg-bg-overlay hover:text-text-1 transition-colors"
          >看板 →</button>
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

      <div className="flex items-center gap-2 px-4 py-2 border-b border-line shrink-0 flex-wrap">
        <input
          value={filter.q}
          onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
          placeholder="搜索任务…"
          className="input !h-7 w-40 text-xs"
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

      <MapLibrary
        open={mapLibOpen}
        onClose={() => setMapLibOpen(false)}
        currentId={rootId}
        onPick={(id) => {
          setRootId(id)
          setMapLibOpen(false)
        }}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'mindmap' && mindmapEnabled && rootId ? (
          <div className="flex h-full min-h-0">
            <div className="flex-1 min-w-0 min-h-0">
              <MindmapCanvas rootId={rootId} />
            </div>
            <TodayTray />
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
