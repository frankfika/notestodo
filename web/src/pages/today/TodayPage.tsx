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
 * 「今天」落地页：一屏只说今天的事 —— 捕获框 + 今日清单 + 今日焦点。
 * 会议 / 助手收成右侧的两张小卡（需要时才展开），打开应用先看到该干嘛，
 * 而不是一屏信息摊开来。（上一版的信息块 / 跳转按钮 / 重复 CTA 全砍了。）
 */
export default function TodayPage(): JSX.Element {
  const goMeeting = useUI((s) => s.goMeeting)
  const goNote = useUI((s) => s.goNote)
  const goTodos = useUI((s) => s.goTodos)
  const setAiOpen = useUI((s) => s.setAiOpen)
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen)
  const phase = useRecorder((s) => s.phase)
  const recMeeting = useRecorder((s) => s.meeting)
  const elapsedMs = useRecorder((s) => s.elapsedMs)
  const stop = useRecorder((s) => s.stop)
  const start = useRecorder((s) => s.start)

  const [newTitle, setNewTitle] = useState('')
  const addRef = useRef<HTMLInputElement>(null)

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

  return (
    <div className="h-full overflow-y-auto" data-testid="today-page">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        {/* 页头：日期 + 两个入口，到此为止 */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-2xl font-semibold text-text-1">今天</h1>
            <span className="text-sm text-text-3">{dateText}</span>
            {overdueCount > 0 && (
              <span className="text-xs text-danger">{overdueCount} 条逾期</span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => goTodos()} className="btn-ghost h-9 px-3 text-sm">
              全部任务
            </button>
            <button
              onClick={() => setShortcutsOpen(true)}
              title="快捷键"
              aria-label="快捷键"
              className="kbd !h-9 min-w-9 hover:text-text-1 transition-colors"
            >?</button>
          </div>
        </div>

        {/* 捕获框：全页唯一的输入入口，写一条回车就走 */}
        <div className="card flex flex-col gap-2 p-3 md:flex-row md:items-center">
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
          <button onClick={() => void addQuick()} className="btn-primary h-10 px-4 text-sm md:shrink-0">
            创建任务
          </button>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.42fr)_minmax(320px,0.86fr)]">
          <div className="space-y-4">
            <SectionCard title="今日清单" count={todaySlots.length}>
              <>
                <TodaySlotsList />
                <div className="mt-3">
                  <TodaySwapPrompt />
                </div>
              </>
            </SectionCard>

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
                  hint={`在上方输入一条，或按 ${mod()}⇧R 开一场会，散会后待办会自动回流到这里。`}
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

          {/* 右侧只留两张小卡：会议（需要时才开会）+ 助手（需要时才叫） */}
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
                        <div className="mt-1 text-xs text-text-3">正在录音 · 已录 {fmtClock(elapsedMs)}</div>
                      </div>
                      <button onClick={() => void stop()} className="btn-danger h-8 px-3 text-xs shrink-0">■ 停止</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <button onClick={() => void start()} className="btn-primary h-8 px-3 text-xs">● 开始录音</button>
                    <span className="text-xs text-text-3">{mod()}⇧R 随时开录，散会后待办自动回流</span>
                  </div>
                )}

                {recentMeetings.length > 0 && (
                  <ul className="flex flex-col gap-1.5">
                    {recentMeetings.slice(0, 2).map((m) => (
                      <li key={m.id}>
                        <button
                          onClick={() => goMeeting(m.id)}
                          className="w-full rounded-[10px] border border-transparent px-2.5 py-2 text-left transition-colors hover:border-line hover:bg-bg-overlay/60"
                        >
                          <div className="flex items-center gap-2">
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
            </SectionCard>

            <SectionCard
              title="助手"
              action={<button onClick={() => setAiOpen(true)} className="btn-ghost h-7 px-2.5 text-xs">⌘J 打开 →</button>}
            >
              <div className="flex items-center gap-2">
                <button onClick={() => setAiOpen(true)} className="btn-outline h-8 px-3 text-xs">✦ 打开助手</button>
                <button
                  onClick={() => void createPage(null, null).then((id) => goNote(id))}
                  className="btn-ghost h-8 px-3 text-xs"
                >＋ 新建笔记</button>
              </div>
            </SectionCard>
          </div>
        </div>
      </div>
    </div>
  )
}
