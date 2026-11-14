import { useLiveQuery } from 'dexie-react-hooks'
import { type JSX, useEffect, useState } from 'react'
import { db } from '../db/db'
import { formatDueLabel } from '../lib/todoMeta'
import { now, today as todayIso } from '../lib/id'
import { archiveTodo, applyTodoStatus, unarchiveTodo } from '../lib/todoStatus'
import { useUI } from '../state/ui'
import DateInput from './DateInput'
import TagPicker from './TagPicker'
import AssigneePicker from './AssigneePicker'
import type { Todo, TodoStatus } from '../types'

async function patchTodo(t: Todo, patch: Partial<Todo>): Promise<void> {
  await db.todos.update(t.id, {
    ...patch,
    updated_at: now(),
    sync_version: t.sync_version + 1,
  })
}

function fmtDateTime(iso?: string | null): string {
  if (!iso) return '未记录'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

export default function TaskDetailDrawer(): JSX.Element | null {
  const todoId = useUI((s) => s.taskDetailTodoId)
  const close = useUI((s) => s.closeTaskDetail)
  const goTodos = useUI((s) => s.goTodos)
  const goNote = useUI((s) => s.goNote)
  const goMeeting = useUI((s) => s.goMeeting)

  const todo = useLiveQuery(async () => (todoId ? ((await db.todos.get(todoId)) ?? null) : null), [todoId])
  const noteTitle = useLiveQuery(
    async () => (todo?.origin_note_id ? ((await db.notes.get(todo.origin_note_id))?.title ?? null) : null),
    [todo?.origin_note_id],
  )
  const mapTitle = useLiveQuery(
    async () => (todo?.map_id ? ((await db.todos.get(todo.map_id))?.title ?? null) : null),
    [todo?.map_id],
  )
  const meetingTitle = useLiveQuery(
    async () => (todo?.meeting_id ? ((await db.meetings.get(todo.meeting_id))?.title ?? null) : null),
    [todo?.meeting_id],
  )

  const [titleDraft, setTitleDraft] = useState('')
  const [noteDraft, setNoteDraft] = useState('')

  useEffect(() => {
    if (todo === null) close()
  }, [todo, close])

  useEffect(() => {
    if (!todo) return
    setTitleDraft(todo.title)
    setNoteDraft(todo.notes_md ?? '')
  }, [todo?.id, todo?.title, todo?.notes_md])

  if (!todoId || !todo) return null

  const saveTitle = async (): Promise<void> => {
    const next = titleDraft.trim()
    if (!next || next === todo.title) return
    await patchTodo(todo, { title: next })
  }

  const saveNotes = async (): Promise<void> => {
    const next = noteDraft.trim()
    if ((todo.notes_md ?? '') === next) return
    await patchTodo(todo, { notes_md: next || undefined })
  }

  const setDueDate = async (value: string): Promise<void> => {
    const due = value || undefined
    await patchTodo(todo, {
      due_date: due,
      due_time: due ? todo.due_time : undefined,
    })
  }

  const setDueTime = async (value: string): Promise<void> => {
    const nextTime = value || undefined
    await patchTodo(todo, {
      due_time: nextTime,
      due_date: todo.due_date ?? (nextTime ? todayIso() : undefined),
    })
  }

  const setStatus = async (next: TodoStatus): Promise<void> => {
    await applyTodoStatus(todo, next)
  }

  return (
    <aside
      aria-label="任务详情"
      className="drawer-enter fixed inset-0 md:inset-auto md:right-0 md:top-0 md:bottom-0 z-40 w-full md:w-[420px] md:border-l border-line bg-bg-raise flex flex-col md:shadow-2xl"
    >
      <div className="flex items-center gap-2 px-4 h-12 border-b border-line shrink-0">
        <span className="text-sm font-medium text-text-1">任务详情</span>
        <span className="text-[11px] text-text-3">标签 / 时间 / 负责人 / 备注 都在这里</span>
        <button onClick={close} className="icon-btn ml-auto" title="关闭" aria-label="关闭">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <section className="card p-4 space-y-3">
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={todo.status === 'done'}
              onChange={() => void setStatus(todo.status === 'done' ? 'open' : 'done')}
              className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
            />
            <div className="min-w-0 flex-1">
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void saveTitle()
                  }
                }}
                className="w-full bg-transparent text-[20px] font-semibold leading-tight text-text-1 outline-none"
                placeholder="任务标题"
              />
              <div className="mt-1 text-xs text-text-3">
                {formatDueLabel(todo.due_date, todo.due_time) || '未安排时间'} · {todo.assignee ? `@${todo.assignee}` : '未指定负责人'}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {todo.status !== 'done' ? (
              <button onClick={() => void setStatus('done')} className="btn-primary h-8 px-3 text-xs">✓ 标记完成</button>
            ) : (
              <button onClick={() => void setStatus('open')} className="btn-outline h-8 px-3 text-xs">重新打开</button>
            )}
            {todo.status !== 'cancelled' ? (
              <button onClick={() => void archiveTodo(todo)} className="btn-outline h-8 px-3 text-xs">归档（这件事黄了）</button>
            ) : (
              <button onClick={() => void unarchiveTodo(todo)} className="btn-outline h-8 px-3 text-xs">取消归档</button>
            )}
            <button onClick={() => { goTodos(todo.id); close() }} className="btn-ghost h-8 px-3 text-xs">在任务页定位</button>
          </div>
        </section>

        <section className="card p-4 space-y-3">
          <div className="section-title">安排</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-text-3 space-y-1">
              <span className="block">日期</span>
              <DateInput
                value={todo.due_date ?? ''}
                onChange={(v) => void setDueDate(v)}
                className="input !h-9 text-sm"
              />
            </label>
            <label className="text-xs text-text-3 space-y-1">
              <span className="block">具体时间</span>
              <input
                type="time"
                value={todo.due_time ?? ''}
                onChange={(e) => void setDueTime(e.target.value)}
                className="input !h-9 text-sm"
              />
            </label>
          </div>
          <div className="text-[11px] text-text-3">
            只有真的需要排到钟点时再填时间；大多数任务只写日期就够了。
          </div>
        </section>

        <section className="card p-4 space-y-3">
          <div className="section-title">属性</div>
          <div>
            <div className="mb-1 text-xs text-text-3">负责人</div>
            <AssigneePicker todoId={todo.id} assignee={todo.assignee} />
          </div>
          <div>
            <div className="mb-1 text-xs text-text-3">标签</div>
            <TagPicker targetType="todo" targetId={todo.id} />
          </div>
        </section>

        <section className="card p-4 space-y-2">
          <div className="section-title">备注</div>
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onBlur={() => void saveNotes()}
            rows={6}
            placeholder="写下补充说明、上下文、风险点或交付口径…"
            className="input !h-auto text-sm leading-relaxed"
          />
        </section>

        <section className="card p-4 space-y-2">
          <div className="section-title">记录</div>
          <div className="text-xs text-text-3 space-y-1">
            <div>所属图谱：{mapTitle ?? (todo.map_id ?? '未归属')}</div>
            <div>创建于：{fmtDateTime(todo.created_at)}</div>
            <div>最近更新：{fmtDateTime(todo.updated_at)}</div>
            <div>完成于：{fmtDateTime(todo.completed_at)}</div>
            <div>归档于：{fmtDateTime(todo.archived_at)}</div>
          </div>
          {todo.map_id && (
            <button
              onClick={() => { goTodos(todo.id); close() }}
              className="btn-outline h-8 px-3 text-xs"
            >
              在对应脑图里打开：{mapTitle ?? todo.map_id}
            </button>
          )}
        </section>

        {(todo.origin_note_id || todo.meeting_id) && (
          <section className="card p-4 space-y-2">
            <div className="section-title">来源</div>
            <div className="flex flex-wrap gap-2">
              {todo.origin_note_id && (
                <button
                  onClick={() => { goNote(todo.origin_note_id!); close() }}
                  className="btn-outline h-8 px-3 text-xs"
                >
                  打开笔记：{noteTitle ?? '来源笔记'}
                </button>
              )}
              {todo.meeting_id && (
                <button
                  onClick={() => { goMeeting(todo.meeting_id!); close() }}
                  className="btn-outline h-8 px-3 text-xs"
                >
                  打开会议：{meetingTitle ?? '来源会议'}
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </aside>
  )
}
