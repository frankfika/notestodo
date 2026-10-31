import { useUI, type ViewName } from '../state/ui'
import { useRecorder } from '../state/recorder'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { db } from '../db/db'
import { useLiveQuery } from 'dexie-react-hooks'
import { isTauri } from '../lib/tauri'
import { DownloadIndicator } from './BuiltinModels'
import { createPage } from '../lib/notes'
import { uid } from '../lib/id'
import type { ID, Note } from '../types'

// 只留 3 个一级入口：看板 / 周报 并入「任务」，模板并入设置与会议页
const NAV: { view: ViewName; label: string; icon: string }[] = [
  { view: 'meetings', label: '会议', icon: '●' },
  { view: 'todos', label: '任务', icon: '◎' },
  { view: 'notes', label: '笔记', icon: '✎' },
]

/** 子页面归属到哪个一级入口（高亮用） */
function navOf(v: ViewName): ViewName {
  if (v === 'meeting-detail') return 'meetings'
  if (v === 'note-detail') return 'notes'
  if (v === 'board' || v === 'report') return 'todos'
  if (v === 'templates') return 'settings'
  return v
}

/**
 * 页面树（PR1 IA）：自由页面按 parent_id 嵌套，会议纪要留在「会议」里不进树。
 * 默认全展开（个人笔记量级），点击 chevron 折叠；hover 行尾 ＋ 新建子页面。
 * 存在笔记本时按笔记本分区；无笔记本的页面落到最后的「未分配」区。
 */
function PageTree(): JSX.Element {
  const notes = useLiveQuery(
    () => db.notes.filter((n) => !n.meeting_id && n.deleted_at === null).toArray(),
    [],
  ) ?? []
  const notebooks = useLiveQuery(
    () => db.notebooks.filter((nb) => nb.deleted_at === null).sortBy('sort_order'),
    [],
  ) ?? []
  const goNote = useUI((s) => s.goNote)
  const view = useUI((s) => s.view)
  const currentId = useUI((s) => s.noteId)
  const [collapsed, setCollapsed] = useState<ReadonlySet<ID>>(new Set())
  const [dragPageId, setDragPageId] = useState<ID | null>(null)
  const [dropTarget, setDropTarget] = useState<ID | null>(null) // 行 id 或 'nb:<id>'/'root'

  /** 防成环：target 是不是 dragged 的子孙 */
  const isDescendant = (draggedId: ID, targetId: ID): boolean => {
    const byId = new Map(notes.map((n) => [n.id, n]))
    let p = byId.get(targetId)?.parent_id ?? null
    const seen = new Set<ID>()
    while (p && !seen.has(p)) {
      if (p === draggedId) return true
      seen.add(p)
      p = byId.get(p)?.parent_id ?? null
    }
    return false
  }

  const dropOnPage = async (targetId: ID): Promise<void> => {
    setDropTarget(null)
    const draggedId = dragPageId
    setDragPageId(null)
    if (!draggedId || draggedId === targetId || isDescendant(draggedId, targetId)) return
    const target = notes.find((n) => n.id === targetId)
    const dragged = notes.find((n) => n.id === draggedId)
    if (!target || !dragged) return
    await db.notes.update(draggedId, {
      parent_id: targetId,
      notebook_id: target.notebook_id ?? null,
      sort_order: Date.now(),
      updated_at: new Date().toISOString(),
    })
  }

  /** 拖到分区头/空白 = 挪到该笔记本（或「未分配」）的根层 */
  const dropOnSection = async (notebookId: ID | null): Promise<void> => {
    setDropTarget(null)
    const draggedId = dragPageId
    setDragPageId(null)
    if (!draggedId) return
    const dragged = notes.find((n) => n.id === draggedId)
    if (!dragged) return
    if ((dragged.parent_id ?? null) === null && (dragged.notebook_id ?? null) === notebookId) return
    await db.notes.update(draggedId, {
      parent_id: null, notebook_id: notebookId, sort_order: Date.now(), updated_at: new Date().toISOString(),
    })
  }

  const childrenOf = (pid: ID | null, notebookId: ID | null | undefined): Note[] =>
    notes
      .filter((n) => (n.parent_id ?? null) === pid && (n.notebook_id ?? null) === (notebookId ?? null))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || b.updated_at.localeCompare(a.updated_at))

  const toggle = (id: ID): void =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const newPage = async (pid: ID | null, notebookId: ID | null = null): Promise<void> => {
    goNote(await createPage(pid, notebookId))
  }

  const newNotebook = async (): Promise<void> => {
    const name = window.prompt('笔记本名称')?.trim()
    if (!name) return
    const ts = new Date().toISOString()
    await db.notebooks.add({
      id: uid(), name, icon: '📓', sort_order: Date.now(),
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
  }

  const renderLevel = (pid: ID | null, depth: number, notebookId: ID | null): ReactNode =>
    childrenOf(pid, notebookId).map((n) => {
      const kids = childrenOf(n.id, notebookId)
      const open = !collapsed.has(n.id)
      return (
        <li key={n.id}>
          <div
            draggable
            onDragStart={(e) => { e.stopPropagation(); setDragPageId(n.id); e.dataTransfer.effectAllowed = 'move' }}
            onDragEnd={() => { setDragPageId(null); setDropTarget(null) }}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (dragPageId && dragPageId !== n.id && !isDescendant(dragPageId, n.id)) setDropTarget(n.id) }}
            onDragLeave={() => setDropTarget((t) => (t === n.id ? null : t))}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void dropOnPage(n.id) }}
            className={`group flex items-center h-7 rounded-[8px] pr-1 text-[13px] cursor-pointer transition-colors ${
              dropTarget === n.id ? 'outline outline-1 outline-accent bg-accent/10' :
              view === 'note-detail' && currentId === n.id ? 'bg-bg-raise text-text-1 font-medium' : 'text-text-2 hover:bg-bg-overlay hover:text-text-1'
            } ${dragPageId === n.id ? 'opacity-40' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => goNote(n.id)}
          >
            <button
              type="button"
              aria-label={open ? '折叠' : '展开'}
              className={`w-4 shrink-0 text-[9px] text-text-3 transition-transform ${kids.length ? '' : 'invisible'} ${open ? '' : '-rotate-90'}`}
              onClick={(e) => { e.stopPropagation(); toggle(n.id) }}
            >▾</button>
            <span className="flex-1 min-w-0 truncate">{n.title || '无标题'}</span>
            <button
              type="button"
              aria-label="新建子页面"
              title="新建子页面"
              className="opacity-0 group-hover:opacity-100 shrink-0 w-5 text-text-3 hover:text-accent"
              onClick={(e) => { e.stopPropagation(); void newPage(n.id, notebookId) }}
            >＋</button>
          </div>
          {open && kids.length > 0 && <ul>{renderLevel(n.id, depth + 1, notebookId)}</ul>}
        </li>
      )
    })

  const renameNotebook = async (nb: { id: ID; name: string }): Promise<void> => {
    const name = window.prompt('重命名笔记本', nb.name)?.trim()
    if (!name || name === nb.name) return
    await db.notebooks.update(nb.id, { name, updated_at: new Date().toISOString() })
  }

  const deleteNotebook = async (nb: { id: ID; name: string }): Promise<void> => {
    if (!window.confirm(`删除笔记本「${nb.name}」？里面的页面不会删，移到「未分配」。`)) return
    await db.notes.where('notebook_id').equals(nb.id).modify({ notebook_id: null })
    await db.notebooks.update(nb.id, { deleted_at: new Date().toISOString() })
  }

  const sectionHeader = (label: ReactNode, onAdd: () => void, addTitle: string, dropKey: ID | null, nb?: { id: ID; name: string }): ReactNode => (
    <div
      className={`group/nb flex items-center px-4 mb-1 mt-2 first:mt-0 rounded-[6px] ${dropTarget === `sec:${dropKey ?? 'root'}` ? 'outline outline-1 outline-accent bg-accent/10' : ''}`}
      onDragOver={(e) => { if (!dragPageId) return; e.preventDefault(); setDropTarget(`sec:${dropKey ?? 'root'}`) }}
      onDragLeave={() => setDropTarget((t) => (t === `sec:${dropKey ?? 'root'}` ? null : t))}
      onDrop={(e) => { e.preventDefault(); void dropOnSection(dropKey) }}
    >
      <span className="text-[11px] tracking-wide text-text-3 truncate">{label}</span>
      {nb && (
        <span className="ml-1 opacity-0 group-hover/nb:opacity-100 flex gap-0.5">
          <button type="button" title="重命名" className="text-text-3 hover:text-accent text-[10px]" onClick={() => void renameNotebook(nb)}>✎</button>
          <button type="button" title="删除笔记本" className="text-text-3 hover:text-danger text-[10px]" onClick={() => void deleteNotebook(nb)}>🗑</button>
        </span>
      )}
      <button
        type="button"
        aria-label={addTitle}
        title={addTitle}
        className="ml-auto shrink-0 text-text-3 hover:text-accent text-sm leading-none"
        onClick={onAdd}
      >＋</button>
    </div>
  )

  const hasUnassigned = notes.some((n) => {
    const nid = n.notebook_id ?? null
    return nid === null || !notebooks.some((nb) => nb.id === nid)
  })

  // 无笔记本：保持原来的一棵「页面」树
  if (notebooks.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col mt-3">
        <div className="flex items-center px-4 mb-1">
          <span className="text-[11px] tracking-wide text-text-3">页面</span>
          <button
            type="button"
            aria-label="新建页面"
            title="新建页面"
            className="ml-auto text-text-3 hover:text-accent text-sm leading-none"
            onClick={() => void newPage(null)}
          >＋</button>
          <button
            type="button"
            aria-label="新建笔记本"
            title="新建笔记本"
            className="ml-2 text-text-3 hover:text-accent text-[11px] leading-none"
            onClick={() => void newNotebook()}
          >＋📓</button>
        </div>
        <ul className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">{renderLevel(null, 0, null)}</ul>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col mt-3">
      <div className="flex items-center px-4 mb-1">
        <span className="text-[11px] tracking-wide text-text-3">页面</span>
        <button
          type="button"
          aria-label="新建笔记本"
          title="新建笔记本"
          className="ml-auto text-text-3 hover:text-accent text-[11px] leading-none"
          onClick={() => void newNotebook()}
        >＋ 笔记本</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
        {notebooks.map((nb) => (
          <div key={nb.id}>
            {sectionHeader(
              <>{nb.icon} {nb.name}</>,
              () => void newPage(null, nb.id),
              `在「${nb.name}」下新建页面`,
              nb.id,
              nb,
            )}
            <ul>{renderLevel(null, 0, nb.id)}</ul>
          </div>
        ))}
        {hasUnassigned && (
          <div>
            {sectionHeader('未分配', () => void newPage(null, null), '新建页面', null)}
            <ul>{renderLevel(null, 0, null)}</ul>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Sidebar() {
  const { view, goMeetings, goNotes, goSettings } = useUI()
  const goTodos = useUI((s) => s.goTodos)
  const phase = useRecorder((s) => s.phase)
  const recMeeting = useRecorder((s) => s.meeting)
  const startRec = useRecorder((s) => s.start)
  const goMeeting = useUI((s) => s.goMeeting)
  const [clock, setClock] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  // 只数「任务」(排除 OKR 的 O / KR)，并剔除已软删条目 — 任务 tab 徽章语义对齐
  const openTodos = useLiveQuery(
    () =>
      db.todos
        .where('status')
        .anyOf('open', 'pending_review')
        .filter((t) => t.kind === 'task' && t.deleted_at === null)
        .count(),
    [],
  )

  const p = (n: number) => String(n).padStart(2, '0')
  const clockText = `${p(clock.getHours())}:${p(clock.getMinutes())}`

  // 侧栏宽度可拖拽伸缩（存 localStorage；双击手柄复位）
  const [width, setWidth] = useState(() => {
    const w = Number(localStorage.getItem('sidebar-w'))
    return w >= 180 && w <= 400 ? w : 232
  })
  const dragW = useRef<{ x: number; w: number } | null>(null)

  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (!dragW.current) return
      const w = Math.min(400, Math.max(180, dragW.current.w + e.clientX - dragW.current.x))
      setWidth(w)
    }
    const up = (): void => {
      if (dragW.current) localStorage.setItem('sidebar-w', String(width))
      dragW.current = null
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
  }, [width])

  return (
    <aside
      style={{ width }}
      className="
      hidden md:flex                          /* 移动端隐藏（由 BottomTabBar 接管） */
      relative shrink-0 flex-col border-r border-line bg-bg-sidebar
    ">
      {/* 桌面版留出的 macOS 红绿灯区域：仅 Tauri 时变成拖拽区，不挡按钮点击 */}
      {isTauri() && <div data-tauri-drag-region aria-hidden className="h-5 shrink-0" />}
      {/* 伸缩手柄：右缘 4px 热区，双击复位 232 */}
      <div
        aria-hidden
        onMouseDown={(e) => { dragW.current = { x: e.clientX, w: width } }}
        onDoubleClick={() => { setWidth(232); localStorage.removeItem('sidebar-w') }}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/40 transition-colors z-10"
      />
      {/* 品牌行 */}
      <div className="flex items-center gap-2 px-4 h-14">
        <span className={`h-2 w-2 rounded-full ${phase === 'recording' ? 'bg-danger rec-dot' : 'bg-accent'}`} />
        <span className="font-semibold tracking-tight text-text-1">NotesToGO</span>
        <span className="text-[11px] text-text-3">拾贝</span>
        <span className="ml-auto font-mono text-xs text-text-3 tabular-nums">{clockText}</span>
      </div>

      {/* 全局录音入口：任何页面一键开始；录音中则回到速记页 */}
      <div className="px-3 mb-1">
        {phase === 'recording' && recMeeting ? (
          <button onClick={() => goMeeting(recMeeting.id)} className="btn-danger w-full h-9 text-sm">● 录音中 · 回到速记</button>
        ) : (
          <button onClick={() => void startRec()} disabled={phase !== 'idle'} className="btn-primary w-full h-9 text-sm">● 开始录音</button>
        )}
      </div>

      <div className="px-3"><DownloadIndicator /></div>

      <nav className="px-2 mt-2 space-y-0.5 shrink-0">
        {NAV.map((item) => {
          const active = navOf(view) === item.view
          return (
            <button
              key={item.view}
              onClick={() =>
                ({ meetings: goMeetings, notes: goNotes, todos: () => goTodos() } as Record<string, () => void>)[item.view]()
              }
              className={`w-full flex items-center gap-2.5 px-3 h-8 rounded-[10px] text-sm transition-colors duration-150 ${
                active ? 'bg-bg-raise text-text-1 font-medium shadow-sm' : 'text-text-2 hover:bg-bg-overlay hover:text-text-1'
              }`}
            >
              <span className={`text-xs w-4 text-center ${item.view === 'meetings' && phase === 'recording' ? 'text-danger rec-dot' : active ? 'text-accent' : 'text-text-3'}`}>
                {item.icon}
              </span>
              {item.label}
              {item.view === 'todos' && (openTodos ?? 0) > 0 && (
                <span className="ml-auto text-[11px] text-text-3 tabular-nums">{openTodos}</span>
              )}
            </button>
          )
        })}
      </nav>

      <PageTree />

      <div className="mt-auto p-2">
        <button
          onClick={goSettings}
          className={`w-full flex items-center gap-2.5 px-3 h-8 rounded-[10px] text-sm transition-colors ${
            navOf(view) === 'settings' ? 'bg-bg-raise text-text-1 font-medium shadow-sm' : 'text-text-3 hover:bg-bg-overlay hover:text-text-1'
          }`}
        >
          <span className="text-xs w-4 text-center">{'⚙\uFE0E'}</span>
          设置
        </button>
      </div>
    </aside>
  )
}

/**
 * 移动端底部 tab bar（替代 Sidebar）。仅 < 768px 显示。
 * 设置入口放进 tab 区域的第 5 个位置；或顶部右上角 ☰ 弹菜单里。
 * 保持与桌面 sidebar 一样的 chip/badge 行为。
 */
export function BottomTabBar() {
  const { view, goMeetings, goNotes, goSettings } = useUI()
  const goTodos = useUI((s) => s.goTodos)
  const phase = useRecorder((s) => s.phase)
  // 只数「任务」(排除 OKR 的 O / KR)，并剔除已软删条目 — 任务 tab 徽章语义对齐
  const openTodos = useLiveQuery(
    () =>
      db.todos
        .where('status')
        .anyOf('open', 'pending_review')
        .filter((t) => t.kind === 'task' && t.deleted_at === null)
        .count(),
    [],
  )

  const items: { view: ViewName; label: string; icon: string; onClick: () => void; badge?: number | null }[] = [
    { view: 'meetings', label: '会议', icon: '●', onClick: goMeetings },
    { view: 'todos', label: '任务', icon: '◎', onClick: () => goTodos(), badge: openTodos ?? 0 },
    { view: 'notes', label: '笔记', icon: '✎', onClick: goNotes },
  ]

  const isActive = (v: ViewName): boolean => navOf(view) === v

  return (
    <nav
      aria-label="主导航"
      className="
        md:hidden                                 /* ← 手机布局 */
        fixed bottom-0 inset-x-0 z-30
        h-16 flex items-stretch bg-bg-raise/95 backdrop-blur
        border-t border-line
        pb-[env(safe-area-inset-bottom)]
      "
    >
      {items.map((item) => {
        const active = isActive(item.view)
        const accent =
          item.view === 'meetings' && phase === 'recording' ? 'text-danger rec-dot' : active ? 'text-accent' : 'text-text-3'
        return (
          <button
            key={item.view}
            onClick={item.onClick}
            className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 text-[10px] ${
              active ? 'text-text-1' : 'text-text-2'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <span className={`text-base leading-none ${accent}`}>{item.icon}</span>
            <span className="relative">
              {item.label}
              {item.badge != null && item.badge > 0 && (
                <span className="absolute -top-2 -right-3 min-w-[14px] h-[14px] px-1 flex items-center justify-center rounded-full bg-accent text-accent-contrast text-[9px] font-medium">
                  {item.badge}
                </span>
              )}
            </span>
          </button>
        )
      })}
      {/* 设置为第 6 个：紧凑放进右下 */}
      <button
        onClick={goSettings}
        className={`px-3 flex flex-col items-center justify-center gap-0.5 text-[10px] ${
          navOf(view) === 'settings' ? 'text-text-1' : 'text-text-2'
        }`}
        aria-label="设置"
      >
        <span className={`text-base leading-none ${navOf(view) === 'settings' ? 'text-accent' : 'text-text-3'}`}>{'⚙\uFE0E'}</span>
        设置
      </button>
    </nav>
  )
}