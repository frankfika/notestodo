import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { useRecorder } from '../../state/recorder'
import { fmtClock, fmtDateTime, today as todayIso } from '../../lib/id'
import EmptyState from '../../components/EmptyState'

/**
 * Today 页：默认首页。三块——
 *   · 正在录音（大卡片；phase===recording 才出现）
 *   · 今日待办（due_date=today 或 meeting-linked-today 或 pending_review）
 *   · 接下来的会议（手动建的为 manual；MVP 无日历集成，给出空状态引导）
 */
export default function TodayPage(): JSX.Element {
  const goMeeting = useUI((s) => s.goMeeting)
  const goTodos = useUI((s) => s.goTodos)
  const setCmdkOpen = useUI((s) => s.setCmdkOpen)
  const phase = useRecorder((s) => s.phase)
  const elapsedMs = useRecorder((s) => s.elapsedMs)
  const recorderMeeting = useRecorder((s) => s.meeting)
  const stop = useRecorder((s) => s.stop)
  const start = useRecorder((s) => s.start)

  const t = todayIso()

  const openTodos = useLiveQuery(
    () => db.todos.where('status').anyOf('open', 'pending_review').toArray(),
    [],
  ) ?? []

  const todayTodos = useMemo(() => {
    return openTodos
      .filter((td) => {
        if (td.due_date === t) return true
        if (td.status === 'pending_review') return true
        return false
      })
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
  }, [openTodos, t])

  const upcomingMeetings = useLiveQuery(
    () =>
      db.meetings
        .where('started_at')
        .above(new Date(Date.now() - 6 * 3600_000).toISOString())
        .reverse()
        .limit(20)
        .toArray(),
    [],
  ) ?? []

  const meetingIdsToday = useMemo(() => {
    const dayStart = new Date(t + 'T00:00:00').getTime()
    const dayEnd = dayStart + 86_400_000
    return new Set(
      upcomingMeetings
        .filter((m) => {
          const start = new Date(m.started_at).getTime()
          return start >= dayStart && start < dayEnd
        })
        .map((m) => m.id),
    )
  }, [upcomingMeetings, t])

  const linkedTodayTodos = useMemo(
    () => openTodos.filter((td) => td.meeting_id && meetingIdsToday.has(td.meeting_id)),
    [openTodos, meetingIdsToday],
  )

  // 接下来还没开的会议：started_at > now 且 status !== failed
  const nextMeetings = useMemo(() => {
    const now = Date.now()
    return upcomingMeetings
      .filter((m) => new Date(m.started_at).getTime() > now - 1800_000 && m.status !== 'failed')
      .slice(0, 5)
  }, [upcomingMeetings])

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-6 py-8 space-y-4">
        {/* 页头 */}
        <div className="flex items-end justify-between mb-2">
          <div>
            <div className="section-title">TODAY · {fmtDateTime(new Date().toISOString()).slice(0, 5)}</div>
            <h1 className="text-2xl font-semibold tracking-tight text-text-1 mt-1">今天</h1>
          </div>
          <button onClick={() => setCmdkOpen(true)} className="btn-outline text-xs h-8">
            <span className="kbd mr-1.5">⌘K</span>搜索 / 命令
          </button>
        </div>

        {/* 1. 正在录音 */}
        {phase === 'recording' && (
          <section className="card p-5 border-danger/30 bg-danger/8">
            <div className="flex items-center gap-3">
              <span className="rec-dot text-2xl text-danger">●</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-1">正在录音</div>
                <div className="font-mono tabular-nums text-2xl text-text-1 mt-0.5">{fmtClock(elapsedMs)}</div>
                {recorderMeeting && (
                  <button
                    onClick={() => goMeeting(recorderMeeting.id)}
                    className="text-xs text-text-2 hover:text-text-1 truncate max-w-full block text-left mt-1"
                  >
                    · {recorderMeeting.title}
                  </button>
                )}
              </div>
              <button
                onClick={() => void stop()}
                className="btn-danger h-10 px-4"
              >
                ■ 停止
              </button>
            </div>
          </section>
        )}

        {/* 2. 今日待办 */}
        <section className="card p-5">
          <div className="flex items-center mb-3">
            <h2 className="section-title">今日待办</h2>
            <span className="ml-2 text-[11px] text-text-3 tabular-nums">{todayTodos.length + linkedTodayTodos.length}</span>
            <button
              onClick={() => goTodos()}
              className="ml-auto text-xs text-text-3 hover:text-text-1"
            >查看全部 →</button>
          </div>

          {(todayTodos.length + linkedTodayTodos.length) === 0 ? (
            <EmptyState
              icon="◌"
              title="今天还没有待办"
              hint="按 ⌘⇧R 开一场会议，或在「待办」页新建一个 Objective。"
              action={
                <button onClick={() => void start()} className="btn-primary h-8 text-xs">
                  ● 开始录音
                </button>
              }
            />
          ) : (
            <ul className="space-y-0.5">
              {todayTodos.map((td) => (
                <li key={td.id} className="text-sm">
                  <span className="text-text-1">☐ {td.title}</span>
                  {td.due_date && <span className="ml-2 text-[11px] text-text-3">📅 今天</span>}
                </li>
              ))}
              {linkedTodayTodos.map((td) => (
                <li key={td.id} className="text-sm">
                  <span className="text-text-2">· {td.title}</span>
                  <span className="ml-2 text-[11px] text-text-3">会议提取 · 待确认</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 3. 接下来的会议 */}
        <section className="card p-5">
          <div className="flex items-center mb-3">
            <h2 className="section-title">接下来的会议</h2>
            <button
              onClick={() => void start()}
              className="ml-auto btn-outline text-xs h-7"
              title="立刻新建一次手动录音"
            >● 新建录音</button>
          </div>

          {nextMeetings.length === 0 ? (
            <EmptyState
              icon="📅"
              title="暂无日程"
              hint="接入日历后会自动出现接下来的会议。现在可以点上面的「新建录音」手动开始。"
            />
          ) : (
            <ul className="divide-y divide-line">
              {nextMeetings.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 py-2.5 cursor-pointer hover:bg-bg-overlay/40 -mx-2 px-2 rounded-lg transition-colors"
                  onClick={() => goMeeting(m.id)}
                >
                  <span className="font-mono tabular-nums text-xs text-text-3 w-12 shrink-0">
                    {fmtDateTime(m.started_at).slice(6)}
                  </span>
                  <span className="flex-1 text-sm text-text-1 truncate">{m.title}</span>
                  <span className="chip">{m.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 提示卡 */}
        <section className="card p-4 flex items-center gap-3">
          <span className="text-lg text-text-3">⌘K</span>
          <div className="flex-1 text-xs text-text-2">
            按 <span className="kbd">⌘K</span> 打开命令面板：跳转、开始录音、导出数据。
          </div>
        </section>
      </div>
    </div>
  )
}