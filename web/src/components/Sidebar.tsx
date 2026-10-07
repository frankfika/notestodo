import { useUI, type ViewName } from '../state/ui'
import { useRecorder } from '../state/recorder'
import { useEffect, useState } from 'react'
import { db } from '../db/db'
import { liveQuery } from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'

const NAV: { view: ViewName; label: string; icon: string }[] = [
  { view: 'today', label: '今天', icon: '◐' },
  { view: 'meetings', label: '会议', icon: '●' },
  { view: 'notes', label: '笔记', icon: '✎' },
  { view: 'todos', label: '待办', icon: '☑' },
  { view: 'templates', label: '模板', icon: '▤' },
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
    <aside className="w-[200px] shrink-0 flex flex-col border-r border-line bg-bg-raise/50">
      {/* 品牌 */}
      <div className="flex items-center gap-2 px-4 h-14">
        <span className={`text-lg leading-none ${phase === 'recording' ? 'text-danger rec-dot' : 'text-accent'}`}>●</span>
        <span className="font-semibold tracking-wide">拾贝</span>
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
              className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-sm transition-colors duration-150 ${
                active ? 'bg-bg-overlay text-text-1 font-medium' : 'text-text-2 hover:bg-bg-overlay/60 hover:text-text-1'
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
          className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-sm transition-colors ${
            view === 'settings' ? 'bg-bg-overlay text-text-1 font-medium' : 'text-text-3 hover:bg-bg-overlay/60 hover:text-text-1'
          }`}
        >
          <span className="text-xs w-4 text-center">⚙</span>
          设置
        </button>
      </div>
    </aside>
  )
}
