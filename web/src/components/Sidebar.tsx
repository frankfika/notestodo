import { useUI, type ViewName } from '../state/ui'
import { useRecorder } from '../state/recorder'
import { useEffect, useState } from 'react'
import { db } from '../db/db'
import { useLiveQuery } from 'dexie-react-hooks'

const NAV: { view: ViewName; label: string; icon: string }[] = [
  { view: 'today', label: '今天', icon: '◐' },
  { view: 'meetings', label: '会议', icon: '●' },
  { view: 'notes', label: '笔记', icon: '✎' },
  { view: 'todos', label: '待办', icon: '◎' },
  { view: 'templates', label: '模板', icon: '▢' },
]

export default function Sidebar() {
  const { view, goToday, goMeetings, goNotes, goTodos, goTemplates, goSettings } = useUI()
  const phase = useRecorder((s) => s.phase)
  const [clock, setClock] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const openTodos = useLiveQuery(
    () => db.todos.where('status').anyOf('open', 'pending_review').count(),
    [],
  )

  const p = (n: number) => String(n).padStart(2, '0')
  const clockText = `${p(clock.getHours())}:${p(clock.getMinutes())}`

  return (
    <aside className="
      hidden md:flex                          /* 移动端隐藏（由 BottomTabBar 接管） */
      w-[208px] shrink-0 flex-col border-r border-line bg-bg-sidebar
    ">
      {/* 品牌 */}
      <div className="flex items-center gap-2 px-4 h-14">
        <span className={`h-2 w-2 rounded-full ${phase === 'recording' ? 'bg-danger rec-dot' : 'bg-accent'}`} />
        <span className="font-semibold tracking-tight text-text-1">NotesToGO</span>
        <span className="text-[11px] text-text-3">拾贝</span>
        <span className="ml-auto font-mono text-xs text-text-3 tabular-nums">{clockText}</span>
      </div>

      <nav className="px-2 mt-2 space-y-0.5">
        {NAV.map((item) => {
          const active =
            view === item.view ||
            (item.view === 'meetings' && view === 'meeting-detail') ||
            (item.view === 'notes' && view === 'note-detail')
          return (
            <button
              key={item.view}
              onClick={() =>
                ({ today: goToday, meetings: goMeetings, notes: goNotes, todos: goTodos, templates: goTemplates } as Record<string, () => void>)[item.view]()
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

      <div className="mt-auto p-2">
        <button
          onClick={goSettings}
          className={`w-full flex items-center gap-2.5 px-3 h-8 rounded-[10px] text-sm transition-colors ${
            view === 'settings' ? 'bg-bg-raise text-text-1 font-medium shadow-sm' : 'text-text-3 hover:bg-bg-overlay hover:text-text-1'
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
  const { view, goToday, goMeetings, goNotes, goTodos, goSettings, goTemplates } = useUI()
  const phase = useRecorder((s) => s.phase)
  const openTodos = useLiveQuery(
    () => db.todos.where('status').anyOf('open', 'pending_review').count(),
    [],
  )

  const items: { view: ViewName; label: string; icon: string; onClick: () => void; badge?: number | null }[] = [
    { view: 'today', label: '今天', icon: '◐', onClick: goToday },
    { view: 'meetings', label: '会议', icon: '●', onClick: goMeetings },
    { view: 'notes', label: '笔记', icon: '✎', onClick: goNotes },
    { view: 'todos', label: '待办', icon: '◎', onClick: goTodos, badge: openTodos ?? 0 },
    { view: 'templates', label: '模板', icon: '▢', onClick: goTemplates },
  ]

  const isActive = (v: ViewName): boolean =>
    view === v ||
    (v === 'meetings' && view === 'meeting-detail') ||
    (v === 'notes' && view === 'note-detail')

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
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] ${
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
          view === 'settings' ? 'text-text-1' : 'text-text-2'
        }`}
        aria-label="设置"
      >
        <span className={`text-base leading-none ${view === 'settings' ? 'text-accent' : 'text-text-3'}`}>{'⚙\uFE0E'}</span>
        设置
      </button>
    </nav>
  )
}