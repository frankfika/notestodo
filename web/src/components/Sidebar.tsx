import { useUI, type ViewName } from '../state/ui'
import { useRecorder } from '../state/recorder'
import { useEffect, useState, type ReactNode } from 'react'
import { db } from '../db/db'
import { useLiveQuery } from 'dexie-react-hooks'
import { isTauri } from '../lib/tauri'
import { DownloadIndicator } from './BuiltinModels'
import { createPage } from '../lib/notes'
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
 */
function PageTree(): JSX.Element {
  const notes = useLiveQuery(
    () => db.notes.filter((n) => !n.meeting_id && n.deleted_at === null).toArray(),
    [],
  ) ?? []
  const goNote = useUI((s) => s.goNote)
  const view = useUI((s) => s.view)
  const currentId = useUI((s) => s.noteId)
  const [collapsed, setCollapsed] = useState<ReadonlySet<ID>>(new Set())

  const childrenOf = (pid: ID | null): Note[] =>
    notes
      .filter((n) => (n.parent_id ?? null) === pid)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || b.updated_at.localeCompare(a.updated_at))

  const toggle = (id: ID): void =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const newPage = async (pid: ID | null): Promise<void> => {
    goNote(await createPage(pid))
  }

  const renderLevel = (pid: ID | null, depth: number): ReactNode =>
    childrenOf(pid).map((n) => {
      const kids = childrenOf(n.id)
      const open = !collapsed.has(n.id)
      return (
        <li key={n.id}>
          <div
            className={`group flex items-center h-7 rounded-[8px] pr-1 text-[13px] cursor-pointer transition-colors ${
              view === 'note-detail' && currentId === n.id ? 'bg-bg-raise text-text-1 font-medium' : 'text-text-2 hover:bg-bg-overlay hover:text-text-1'
            }`}
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
              onClick={(e) => { e.stopPropagation(); void newPage(n.id) }}
            >＋</button>
          </div>
          {open && kids.length > 0 && <ul>{renderLevel(n.id, depth + 1)}</ul>}
        </li>
      )
    })

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
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">{renderLevel(null, 0)}</ul>
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

  return (
    <aside className="
      hidden md:flex                          /* 移动端隐藏（由 BottomTabBar 接管） */
      w-[232px] shrink-0 flex-col border-r border-line bg-bg-sidebar
    ">
      {/* 桌面版留出的 macOS 红绿灯区域：仅 Tauri 时变成拖拽区，不挡按钮点击 */}
      {isTauri() && <div data-tauri-drag-region aria-hidden className="h-5 shrink-0" />}
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