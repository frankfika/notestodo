import { type JSX, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { fmtClock, fmtDateTime, mod, today as todayIso } from '../../lib/id'
import { parseQuickAdd } from '../../lib/quickAdd'
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

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

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
          {overdue ? '逾期' : '今天'}
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
  const goTodos = useUI((s) => s.goTodos)
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen)
  const phase = useRecorder((s) => s.phase)
  const recMeeting = useRecorder((s) => s.meeting)
  const elapsedMs = useRecorder((s) => s.elapsedMs)
  const stop = useRecorder((s) => s.stop)

  const [newTitle, setNewTitle] = useState('')
  const addRef = useRef<HTMLInputElement>(null)

  const today = todayIso()
  const dateText = useMemo(() => {
    const d = new Date()
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`
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
  const nothing = focus.open.length === 0 && focus.finished.length === 0 && recentMeetings.length === 0 && !recording

  return (
    <div className="h-full flex flex-col relative" data-testid="today-page">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-line shrink-0">
        <h1 className="text-sm font-semibold text-text-1">今天</h1>
        <span className="text-[11px] text-text-3">{dateText}</span>
        <div className="flex-1" />
        <button
          onClick={() => setShortcutsOpen(true)}
          title="快捷键"
          aria-label="快捷键"
          className="kbd !h-6 hover:text-text-1 transition-colors"
        >?</button>
      </div>

      {/* 快速添加：回车即建，默认今天到期 */}
      <div className="px-4 py-2 border-b border-line shrink-0">
        <input
          ref={addRef}
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') void addQuick()
          }}
          placeholder="＋ 添加任务，回车创建（默认今天到期，支持「明天 交方案 @张三」）"
          className="input !h-8 w-full text-sm"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {recording && (
          <div className="card flex items-center gap-3 px-4 py-3 mb-4">
            <span className="rec-dot h-2 w-2 rounded-full bg-danger shrink-0" />
            <div className="min-w-0 flex-1">
              <button
                onClick={() => goMeeting(recMeeting.id)}
                className="block text-sm font-medium text-text-1 truncate hover:text-accent"
                title="回到速记"
              >{recMeeting.title}</button>
              <div className="text-[11px] text-text-3">正在录音 · 已录 {fmtClock(elapsedMs)}</div>
            </div>
            <button onClick={() => void stop()} className="btn-danger text-xs h-7 px-3 shrink-0">■ 停止</button>
          </div>
        )}

        {/* 今日清单（脑图 ⌘T 入槽的执行项）永远在最上面 ——
            它才是「今天要做什么」，不该被空态吞掉 */}
        <div className="space-y-5">
          <section>
            <div className="section-title flex items-center gap-2 mb-1.5">
              今日清单
              <span className="text-text-3 font-normal normal-case tracking-normal">
                {todaySlots.length}
              </span>
            </div>
            <TodaySlotsList />
            <div className="mt-1.5">
              <TodaySwapPrompt />
            </div>
          </section>

        {nothing ? (
          <EmptyState
            icon="☼"
            title="今天还没有安排"
            hint={`这里会集中显示今天到期的任务、正在进行的录音和最近的会议。先加一条任务，或按 ${mod()}⇧R 开一场会。`}
            action={
              <button onClick={() => addRef.current?.focus()} className="btn-primary h-8 text-xs">＋ 添加任务</button>
            }
            secondary={
              <button onClick={() => goTodos()} className="btn-outline h-8 text-xs">查看全部任务</button>
            }
          />
        ) : (
          <div className="space-y-5">
            <section>
              <div className="section-title flex items-center gap-2 mb-1.5">
                今日焦点
                <span className="text-text-3 font-normal normal-case tracking-normal">{focus.open.length}</span>
              </div>
              {focus.open.length === 0 && focus.finished.length === 0 ? (
                <div className="text-sm text-text-3 py-3">今天没有到期的任务</div>
              ) : (
                <>
                  {focus.open.length > 0 && (
                    <div className="flex flex-col gap-0.5">
                      {focus.open.map((t) => (
                        <FocusRow key={t.id} t={t} all={all} tagByTodo={tagByTodo} tagsById={tagsById} today={today} />
                      ))}
                    </div>
                  )}
                  {focus.finished.length > 0 && (
                    <>
                      <div className="section-title mt-3 mb-1">已完成</div>
                      <div className="flex flex-col gap-0.5">
                        {focus.finished.map((t) => (
                          <FocusRow key={t.id} t={t} all={all} tagByTodo={tagByTodo} tagsById={tagsById} today={today} />
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </section>

            <section>
              <div className="section-title flex items-center gap-2 mb-1.5">
                最近的会议
                <span className="text-text-3 font-normal normal-case tracking-normal">{recentMeetings.length}</span>
              </div>
              {recentMeetings.length === 0 ? (
                <div className="text-sm text-text-3 py-3">还没有会议记录 · 按 {mod()}⇧R 开始第一场</div>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {recentMeetings.map((m) => (
                    <li key={m.id}>
                      <button
                        onClick={() => goMeeting(m.id)}
                        className="w-full flex items-center gap-2 h-9 px-2 rounded-[8px] hover:bg-bg-overlay text-left transition-colors"
                      >
                        <span className="text-xs text-text-3 shrink-0">●</span>
                        <span className="flex-1 min-w-0 truncate text-sm text-text-1">{m.title}</span>
                        <span className="text-[11px] text-text-3 shrink-0">{fmtDateTime(m.started_at)}</span>
                        <span className="chip text-[10px] shrink-0">{statusText(m)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}
