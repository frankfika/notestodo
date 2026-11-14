import { type JSX, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { fmtClock, fmtDateTime, mod, today as todayIso } from '../../lib/id'
import { parseQuickAdd } from '../../lib/quickAdd'
import { createPage } from '../../lib/notes'
import { isMindmapTasksEnabled } from '../../lib/features'
import { createTask } from '../../lib/mindmap/createTask'
import { ensureInboxMap } from '../../lib/mindmap/mapRoots'
import { statusText } from '../../lib/meetingStatus'
import { useUI } from '../../state/ui'
import { useRecorder } from '../../state/recorder'
import { useAllTodos } from '../../lib/useAllTodos'
import { buildTagByTodo, EMPTY_FILTER, passFilter, type TodoFilter } from '../todos/filter'
import { EditableTitle, TodoMenu } from '../todos/todoRowOps'
import TodoTags from '../todos/TodoTags'
import EmptyState from '../../components/EmptyState'
import type { Tag, Todo } from '../../types'
import { applyTodoStatus } from '../../lib/todoStatus'
import { getToday } from '../../lib/mindmap/todaySlots'
import { TodaySlotsList, TodaySwapPrompt } from '../todos/TodaySlots'
import { formatDueLabel } from '../../lib/todoMeta'

function SectionCard({
  title,
  count,
  action,
  children,
}: {
  title: string
  count?: number
  action?: JSX.Element
  children: JSX.Element
}): JSX.Element {
  return (
    <section className="card p-4 md:p-5">
      <div className="mb-3 flex items-center gap-2">
        <div className="section-title">{title}</div>
        {typeof count === 'number' && (
          <span className="text-xs text-text-3 tabular-nums">{count}</span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  )
}

/** 勾选完成 / 取消完成 */
async function toggle(t: Todo): Promise<void> {
  await applyTodoStatus(t, t.status === 'done' ? 'open' : 'done')
}

/** 今日焦点的一行：勾选框 + 单击即改的标题 + 标签 + 日期 + 行尾菜单 */
function FocusRow({ t, all, tagByTodo, tagsById, today }: {
  t: Todo
  all: Todo[]
  tagByTodo: Map<string, string[]>
  tagsById: Map<string, Tag>
  today: string
}): JSX.Element {
  const overdue = (t.due_date ?? '') < today
  return (
    <div className="group flex items-center gap-2 h-9 px-2 rounded-[8px] hover:bg-bg-overlay transition-colors">
      <input
        type="checkbox"
        checked={t.status === 'done'}
        onChange={() => void toggle(t)}
        aria-label={`完成 ${t.title}`}
        className="shrink-0 accent-[var(--accent)]"
      />
      <div className="flex-1 min-w-0">
        <EditableTitle
          t={t}
          className={`block truncate text-sm ${t.status === 'done' ? 'line-through text-text-3' : 'text-text-1'}`}
        />
      </div>
      <TodoTags ids={tagByTodo.get(t.id) ?? []} tagsById={tagsById} />
      {t.due_date && (
        <span className={`text-[11px] font-mono shrink-0 ${overdue ? 'text-danger' : 'text-accent'}`}>
          {overdue ? `逾期 ${formatDueLabel(t.due_date, t.due_time)}` : formatDueLabel(t.due_date, t.due_time)}
        </span>
      )}
      <TodoMenu t={t} all={all} />
    </div>
  )
}

/**
 * 「今天」落地页：把用户当天要做的事摊在一屏里 —— 今天的任务、正在录的会、最近的会议。
 * 目的：打开应用就知道该干嘛，而不是面对一个空空的 AI 输入框。
 */
export default function TodayPage(): JSX.Element {
  const goMeeting = useUI((s) => s.goMeeting)
  const goNote = useUI((s) => s.goNote)
  const goTodos = useUI((s) => s.goTodos)
  const setAiOpen = useUI((s) => s.setAiOpen)
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen)
  const start = useRecorder((s) => s.start)
  const phase = useRecorder((s) => s.phase)
  const recMeeting = useRecorder((s) => s.meeting)
  const elapsedMs = useRecorder((s) => s.elapsedMs)
  const stop = useRecorder((s) => s.stop)

  const [newTitle, setNewTitle] = useState('')
  const addRef = useRef<HTMLInputElement>(null)
  const todaySectionRef = useRef<HTMLElement>(null)

  const today = todayIso()
  const dateText = useMemo(() => {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      weekday: 'long',
    }).format(new Date())
  }, [])

  const all = useAllTodos()
  const tags = useLiveQuery(() => db.tags.toArray(), []) ?? []
  const todayState = useLiveQuery(getToday, []) ?? { capacity: 5, slots: [] }
  const todaySlots = todayState.slots
  const bindings = useLiveQuery(() => db.tagBindings.toArray(), []) ?? []
  const tagByTodo = useMemo(() => buildTagByTodo(bindings), [bindings])
  const tagsById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])

  const recentMeetings = useLiveQuery(async () => {
    const list = await db.meetings.filter((m) => m.deleted_at === null).toArray()
    return list.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 3)
  }, []) ?? []
  const noteCount = useLiveQuery(() => db.notes.filter((n) => n.deleted_at === null).count(), []) ?? 0
  const meetingCount = useLiveQuery(
    () => db.meetings.filter((m) => m.deleted_at === null).count(),
    [],
  ) ?? 0

  // 今日焦点 = 今天到期 + 已逾期的任务，按状态分成「进行中 / 已完成」两组
  const focus = useMemo(() => {
    const activeFilter: TodoFilter = { ...EMPTY_FILTER, status: 'active' }
    const doneFilter: TodoFilter = { ...EMPTY_FILTER, status: 'done' }
    const due = all.filter((t) =>
      t.kind === 'task' &&
      t.deleted_at === null &&
      t.status !== 'cancelled' &&
      !!t.due_date &&
      t.due_date <= today,
    )
    const open = due
      .filter((t) => passFilter(t, activeFilter, tagByTodo))
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''))
    const finished = due
      .filter((t) => passFilter(t, doneFilter, tagByTodo))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    return { open, finished }
  }, [all, tagByTodo, today])
  const openTaskCount = useMemo(
    () =>
      all.filter((t) => t.kind === 'task' && t.deleted_at === null && t.status !== 'done' && t.status !== 'cancelled').length,
    [all],
  )
  const liveTaskCount = useMemo(
    () => all.filter((t) => t.kind === 'task' && t.deleted_at === null).length,
    [all],
  )
  const overdueCount = useMemo(
    () =>
      all.filter((t) =>
        t.kind === 'task' &&
        t.deleted_at === null &&
        t.status !== 'done' &&
        t.status !== 'cancelled' &&
        !!t.due_date &&
        t.due_date < today,
      ).length,
    [all, today],
  )

  const addQuick = async (): Promise<void> => {
    const raw = newTitle.trim()
    if (!raw) return
    const parsed = parseQuickAdd(raw)
    // 脑图模式下，「今天」页的快速添加是捕获语义：进 Inbox 图，
    // 不再建无 map_id 的孤儿图根污染图库；经典模式仍建独立根任务。
    const mindmap = await isMindmapTasksEnabled()
    const inbox = mindmap ? await ensureInboxMap() : null
    await createTask({
      title: parsed.title,
      placement: inbox ? { under: inbox } : { root: true },
      assignee: parsed.assignee,
      // 今天页里加的任务默认今天到期；写了日期就按写的来
      dueDate: parsed.due_date ?? today,
    })
    setNewTitle('')
  }

  const recording = phase === 'recording' && recMeeting
  const aiEmpty = noteCount === 0 && liveTaskCount === 0 && meetingCount === 0
  const primaryFocus = focus.open[0] ?? todaySlots[0] ?? null

  const jumpToToday = (): void => {
    todaySectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="today-page">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <section className="card px-4 py-4 md:px-5 md:py-5">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="section-title">工作台</div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="text-2xl font-semibold text-text-1 text-balance">今天</h1>
                <span className="text-sm text-text-3">{dateText}</span>
              </div>
              <p className="mt-2 max-w-[44ch] text-sm leading-relaxed text-text-2">
                打开以后只先处理一件事，不把会议、任务、笔记和助手同时摊到你面前。
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => jumpToToday()}
                className="btn-outline h-9 px-3 text-sm"
              >今日清单</button>
              <button
                onClick={() => goTodos()}
                className="btn-ghost h-9 px-3 text-sm"
              >全部任务</button>
              <button
                onClick={() => setShortcutsOpen(true)}
                title="快捷键"
                aria-label="快捷键"
                className="kbd !h-9 min-w-9 hover:text-text-1 transition-colors"
              >?</button>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-line bg-bg px-4 py-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-[0.08em] text-text-3">
                  {recording ? '当前正在进行' : todaySlots.length > 0 ? '下一步先做' : '先开始'}
                </div>
                <div className="mt-1 text-xl font-semibold leading-tight text-text-1 text-balance">
                  {recording
                    ? recMeeting?.title || '继续当前会议'
                    : todaySlots.length > 0
                      ? primaryFocus?.title || '继续今日清单里的第一条'
                      : '先把今天第一条任务放进来'}
                </div>
                <p className="mt-2 max-w-[56ch] text-sm leading-relaxed text-text-2">
                  {recording
                    ? `已经录了 ${fmtClock(elapsedMs)}。先把这场会走完，再回来看待办。`
                    : todaySlots.length > 0
                      ? `今日清单 ${todaySlots.length}/${todayState.capacity}，${overdueCount > 0 ? `还有 ${overdueCount} 条逾期任务需要回收。` : '先把执行位里的事推进完，再去看剩下的大盘。'}`
                      : `待推进任务 ${openTaskCount} 条。别先看大盘，先放进今天 1 条真正要做的事。`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {recording ? (
                  <>
                    <button onClick={() => goMeeting(recMeeting!.id)} className="btn-primary h-9 px-4 text-sm">回到会议</button>
                    <button onClick={() => void stop()} className="btn-outline h-9 px-4 text-sm">停止录音</button>
                  </>
                ) : todaySlots.length > 0 ? (
                  <>
                    <button onClick={() => jumpToToday()} className="btn-primary h-9 px-4 text-sm">继续今日清单</button>
                    <button onClick={() => addRef.current?.focus()} className="btn-outline h-9 px-4 text-sm">补一条任务</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => addRef.current?.focus()} className="btn-primary h-9 px-4 text-sm">加第一条任务</button>
                    <button onClick={() => void start()} className="btn-outline h-9 px-4 text-sm">开始录音</button>
                  </>
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-2 md:flex-row">
              <input
                ref={addRef}
                value={newTitle}
                name="todayQuickAdd"
                autoComplete="off"
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') void addQuick()
                }}
                placeholder="＋ 记下下一步，回车创建（默认今天到期，支持「明天 交方案 @张三」）"
                className="input !h-10 w-full text-sm"
              />
              <button onClick={() => void addQuick()} className="btn-primary h-10 px-4 text-sm md:shrink-0">创建任务</button>
            </div>
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.42fr)_minmax(320px,0.86fr)]">
          <div className="space-y-4">
            <section ref={todaySectionRef}>
            <SectionCard title="今日清单" count={todaySlots.length}>
              <>
                <TodaySlotsList />
                <div className="mt-3">
                  <TodaySwapPrompt />
                </div>
              </>
            </SectionCard>
            </section>

            <SectionCard
              title="今日焦点"
              count={focus.open.length}
              action={<button onClick={() => goTodos()} className="btn-ghost h-7 px-2.5 text-xs">全部任务 →</button>}
            >
              {focus.open.length === 0 && focus.finished.length === 0 ? (
                <EmptyState
                  compact
                  icon="☼"
                  title="今天没有到期任务"
                  hint={`先把一条任务放进今日清单，或按 ${mod()}⇧R 开一场会，散会后待办会自动回流到这里。`}
                  action={<button onClick={() => addRef.current?.focus()} className="btn-primary h-8 px-3 text-xs">＋ 添加任务</button>}
                />
              ) : (
                <div>
                  {focus.open.length > 0 && (
                    <div className="flex flex-col gap-0.5">
                      {focus.open.map((t) => (
                        <FocusRow key={t.id} t={t} all={all} tagByTodo={tagByTodo} tagsById={tagsById} today={today} />
                      ))}
                    </div>
                  )}
                  {focus.finished.length > 0 && (
                    <>
                      <div className="section-title mt-4 mb-1.5">已完成</div>
                      <div className="flex flex-col gap-0.5">
                        {focus.finished.map((t) => (
                          <FocusRow key={t.id} t={t} all={all} tagByTodo={tagByTodo} tagsById={tagsById} today={today} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </SectionCard>
          </div>

          <div className="space-y-4 xl:sticky xl:top-6 self-start">
            <SectionCard
              title="会议"
              action={<button onClick={() => goMeeting(recMeeting?.id ?? recentMeetings[0]?.id ?? '')} disabled={!recording && recentMeetings.length === 0} className="btn-ghost h-7 px-2.5 text-xs disabled:opacity-40">查看全部 →</button>}
            >
              <div className="space-y-3">
                {recording ? (
                  <div className="rounded-2xl border border-danger/20 bg-danger/6 px-4 py-3.5">
                    <div className="flex items-start gap-3">
                      <span className="rec-dot mt-1 h-2.5 w-2.5 rounded-full bg-danger shrink-0" />
                      <div className="min-w-0 flex-1">
                        <button
                          onClick={() => goMeeting(recMeeting.id)}
                          className="block truncate text-left text-sm font-medium text-text-1 hover:text-accent"
                          title="回到速记"
                        >{recMeeting.title}</button>
                        <div className="mt-1 text-xs text-text-3">正在录音 · 已录 {fmtClock(elapsedMs)} · 返回即可继续速记与看字幕</div>
                      </div>
                      <button onClick={() => void stop()} className="btn-danger h-8 px-3 text-xs shrink-0">■ 停止</button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-line bg-bg px-3 py-3">
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 text-sm text-text-3">●</span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-text-1">需要时再开会</div>
                        <div className="mt-1 text-xs leading-relaxed text-text-3">
                          从这里或按 {mod()}⇧R 开录。散会后纪要和待办会自动回流。
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button onClick={() => useRecorder.getState().start()} className="btn-primary h-8 px-3 text-xs">● 开始录音</button>
                      <button onClick={() => recentMeetings[0] && goMeeting(recentMeetings[0].id)} disabled={recentMeetings.length === 0} className="btn-outline h-8 px-3 text-xs disabled:opacity-40">查看最近会议</button>
                    </div>
                  </div>
                )}

                <div className="rounded-2xl border border-line bg-bg px-3 py-3">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium text-text-1">最近的会议</div>
                    <span className="text-xs text-text-3 tabular-nums">{recentMeetings.length}</span>
                  </div>
                  {recentMeetings.length === 0 ? (
                    <div className="mt-2 text-xs leading-relaxed text-text-3">
                        录完第一场会议后，这里会只保留最近入口，不把整套会议系统摊开。
                    </div>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-1.5">
                      {recentMeetings.slice(0, 2).map((m) => (
                        <li key={m.id}>
                          <button
                            onClick={() => goMeeting(m.id)}
                            className="w-full rounded-[10px] border border-transparent px-2.5 py-2 text-left transition-colors hover:border-line hover:bg-bg-overlay/60"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-text-3 shrink-0">●</span>
                              <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-1">{m.title}</span>
                              <span className="chip shrink-0 text-[10px]">{statusText(m)}</span>
                            </div>
                            <div className="mt-1 flex items-center gap-2 text-[11px] text-text-3">
                              <span>{fmtDateTime(m.started_at)}</span>
                              <span>·</span>
                              <span>{fmtClock(m.audio.duration_ms)}</span>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="助手"
              action={<button onClick={() => setAiOpen(true)} className="btn-ghost h-7 px-2.5 text-xs">⌘J 打开 →</button>}
            >
              <div className="space-y-3">
                <div className="rounded-2xl border border-line bg-bg px-3 py-3">
                  <div className="text-sm font-medium text-text-1">需要时再叫出来</div>
                  <div className="mt-1 text-xs leading-relaxed text-text-3">
                    {aiEmpty
                      ? '现在先专心做事。等你有笔记、任务或会议记录以后，再让助手帮你总结、追问或改写。'
                      : `可引用 ${noteCount} 条笔记、${liveTaskCount} 个任务、${meetingCount} 场会议。助手更适合在你卡住时再拉出来。`}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button onClick={() => setAiOpen(true)} className="btn-outline h-8 px-3 text-xs">✦ 打开助手</button>
                    <button
                      onClick={() => void createPage(null, null).then((id) => goNote(id))}
                      className="btn-ghost h-8 px-3 text-xs"
                    >＋ 新建笔记</button>
                  </div>
                </div>
              </div>
            </SectionCard>
          </div>
        </div>
      </div>
    </div>
  )
}
