import { statusText } from '../../lib/meetingStatus'
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { useRecorder } from '../../state/recorder'
import { getCachedSettings } from '../../db/settings'
import { fetchCalendar, type CalendarEvent } from '../../calendar/ics'
import { fmtClock, fmtDateTime, mod, now, today as todayIso } from '../../lib/id'
import type { Todo } from '../../types'
import EmptyState from '../../components/EmptyState'
import LevelMeter from '../../components/LevelMeter'
import QuickAddBar from '../../components/QuickAddBar'
import { attachTask, discardTask } from '../../lib/todoActions'
import { suggestKr } from '../../lib/okr'

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
  const audioLevel = useRecorder((s) => s.audioLevel)
  const stop = useRecorder((s) => s.stop)
  const start = useRecorder((s) => s.start)

  const t = todayIso()

  const openTodos = useLiveQuery(
    () => db.todos.where('status').anyOf('open', 'pending_review').toArray(),
    [],
  ) ?? []

  const krs = useLiveQuery(
    () => db.todos.where('kind').equals('kr').and((k) => k.deleted_at === null && k.status === 'open').toArray(),
    [],
  ) ?? []

  // Today 只看两件事：Inbox（未挂 KR）+ 今天到期/逾期。不展开 OKR 树。
  const { inbox, due } = useMemo(() => {
    const tasks = openTodos.filter((td) => td.kind === 'task' && td.deleted_at === null)
    const due = tasks
      .filter((td) => td.due_date && td.due_date <= t)
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
    const dueIds = new Set(due.map((d) => d.id))
    return { inbox: tasks.filter((td) => td.parent_id === null && !dueIds.has(td.id)), due }
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

  // 接下来还没开的会议：started_at > now 且 status !== failed
  const nextMeetings = useMemo(() => {
    const now = Date.now()
    return upcomingMeetings
      .filter((m) => new Date(m.started_at).getTime() > now - 1800_000 && m.status !== 'failed')
      .slice(0, 5)
  }, [upcomingMeetings])

  // ── 日历订阅（settings.calendar_ics_urls）──────────────────────────
  const [calEvents, setCalEvents] = useState<CalendarEvent[]>([])
  const [calError, setCalError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getCachedSettings()
      .then((s) => fetchCalendar(s))
      .then((r) => {
        if (cancelled) return
        setCalEvents(r.events)
        setCalError(r.error ?? null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setCalError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
    // 只在进入「今天」时拉一次（15 分钟缓存）；改日历 URL 在设置页，回来即重新挂载。
    // 别依赖 upcomingMeetings：`useLiveQuery() ?? []` 每次渲染换引用 → 无限重拉，点「今天」时主线程卡死
  }, [])

  // 未来 12 小时之内的日程
  const upcomingCal = useMemo(() => {
    const now = Date.now()
    const horizon = now + 12 * 3600_000
    return calEvents
      .filter((e) => {
        const s = new Date(e.start).getTime()
        return s >= now - 30 * 60_000 && s <= horizon
      })
      .slice(0, 8)
  }, [calEvents])

  async function startRecordingForEvent(ev: CalendarEvent): Promise<void> {
    // 设置会议开始时间（保留日历事件为元信息：记录到 KV 让关联使用）
    // 然后启动录音；engine.startRecorder 会创建一个 meeting row，
    // 我们在 engine 启动后覆盖 title 与 started_at。
    await db.kv.put({ key: `pending_meeting_meta`, value: {
      title: ev.title,
      start_at: ev.start,
      calendar_event_id: ev.uid,
    } })
    await start()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-6 py-8 space-y-3">
        {/* 页头 */}
        <div className="flex items-end justify-between mb-2">
          <div>
            <div className="section-title">TODAY · {fmtDateTime(new Date().toISOString()).slice(0, 5)}</div>
            <h1 className="text-2xl font-semibold tracking-tight text-text-1 mt-1">今天</h1>
          </div>
          <button onClick={() => setCmdkOpen(true)} className="btn-outline text-xs h-8">
            <span className="kbd mr-1.5">{mod()}K</span>搜索 / 命令
          </button>
        </div>

        {/* 2. 今日：到期 + Inbox */}
        <section className="card p-4">
          <div className="flex items-center mb-2 px-1">
            <h2 className="section-title">今日</h2>
            <span className="ml-2 text-[11px] text-text-3 tabular-nums">{due.length + inbox.length}</span>
            <button onClick={() => goTodos()} className="ml-auto text-xs text-text-3 hover:text-text-1">全部任务 →</button>
          </div>
          <div className="mb-2"><QuickAddBar /></div>

          {due.length + inbox.length === 0 ? (
            <EmptyState
              title="今天没有要处理的事"
              hint={`按 ${mod()}⇧R 开一场会议：会中只记关键词，散会自动整理成笔记。`}
              action={<button onClick={() => void start()} className="btn-primary h-8 text-xs px-3">● 开始录音</button>}
            />
          ) : (
            <ul className="divide-y divide-line">
              {due.map((td) => <TodayRow key={td.id} todo={td} krs={krs} hint={td.due_date === t ? '今天' : `逾期 · ${td.due_date}`} overdue={td.due_date !== t} />)}
              {inbox.map((td) => <TodayRow key={td.id} todo={td} krs={krs} hint={td.status === 'pending_review' ? '会议提取 · 待确认' : 'Inbox'} />)}
            </ul>
          )}
        </section>

        {/* 3. 接下来的会议 */}
        <section className="card p-4">
          <div className="flex items-center mb-3">
            <h2 className="section-title">接下来的会议</h2>
            <button
              onClick={() => void start()}
              className="ml-auto btn-outline text-xs h-7"
              title="立刻新建一次手动录音"
            >● 新建录音</button>
          </div>

          {upcomingCal.length === 0 && nextMeetings.length === 0 ? (
            <EmptyState
              icon="◌"
              title="暂无日程"
              hint={calError
                  ? `日历同步失败：${calError.slice(0, 80)}。可去「设置」页调整 URL，或点上面的「新建录音」手动开始。`
                  : '接入 .ics 日历后会自动出现接下来的会议；现在可点上面的「新建录音」手动开始。'}
              action={
                <button onClick={() => useUI.getState().goSettings()} className="btn-outline h-8 text-xs">
                  去设置
                </button>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {upcomingCal.map((ev) => (
                <li
                  key={`cal-${ev.id}`}
                  className="flex items-center gap-3 py-2.5 group"
                >
                  <span className="font-mono tabular-nums text-xs text-text-3 w-12 shrink-0">
                    {fmtDateTime(ev.start).slice(6)}
                  </span>
                  <span className="flex-1 text-sm text-text-1 truncate">{ev.title}</span>
                  <span className="chip text-[10px]">{ev.source_label}</span>
                  <button
                    onClick={() => void startRecordingForEvent(ev)}
                    className="opacity-0 group-hover:opacity-100 btn-primary text-xs h-7 transition-opacity"
                  >
                    ● 录制
                  </button>
                </li>
              ))}
              {nextMeetings.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 py-2.5 cursor-pointer hover:bg-bg-overlay/40 -mx-2 px-2 transition-colors"
                  onClick={() => goMeeting(m.id)}
                >
                  <span className="font-mono tabular-nums text-xs text-text-3 w-12 shrink-0">
                    {fmtDateTime(m.started_at).slice(6)}
                  </span>
                  <span className="flex-1 text-sm text-text-1 truncate">{m.title}</span>
                  <span className="chip">{statusText(m)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}


function TodayRow({ todo, hint, overdue, krs }: { todo: Todo; hint: string; overdue?: boolean; krs: Todo[] }): JSX.Element {
  const goMeeting = useUI((s) => s.goMeeting)
  const pending = todo.status === 'pending_review'
  const kr = pending ? suggestKr(todo.title, krs) : null
  return (
    <li className="group flex items-center gap-2.5 py-2 px-1">
      {pending ? (
        <button
          onClick={() => void attachTask(todo, kr)}
          className="h-4 w-4 shrink-0 rounded-full border border-dashed border-accent text-[9px] text-accent hover:bg-accent/10"
          aria-label="确认"
          title={kr ? `确认并挂到「${kr.title}」` : '确认，进 Inbox'}
        >✓</button>
      ) : (
        <button
          onClick={() => void db.todos.update(todo.id, { status: 'done', updated_at: now() })}
          className="h-4 w-4 shrink-0 rounded-full border border-line-strong hover:border-accent transition-colors"
          aria-label="完成"
        />
      )}
      {pending && todo.meeting_id ? (
        <button onClick={() => goMeeting(todo.meeting_id!)} className="flex-1 min-w-0 text-left text-sm text-text-2 hover:text-text-1 truncate">{todo.title}</button>
      ) : (
        <span className="flex-1 min-w-0 text-sm text-text-1 truncate">{todo.title}</span>
      )}
      <span className={`text-[11px] shrink-0 ${overdue ? 'text-danger' : 'text-text-3'}`}>{kr ? `→ ${kr.title}` : hint}</span>
      {pending && (
        <button onClick={() => void discardTask(todo)} className="opacity-0 group-hover:opacity-100 text-text-disabled hover:text-danger text-xs" aria-label="丢弃" title="不是待办，丢弃">✕</button>
      )}
    </li>
  )
}
