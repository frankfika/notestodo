import { useMemo } from 'react'
import { db } from '../db/db'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Todo, TodoKind, TodoStatus } from '../types'
import { fmtDate } from '../lib/id'

export interface TodoRowProps {
  todo: Todo
  onEdit?: (t: Todo) => void
  onConfirm?: (t: Todo) => void
  onDelete?: (t: Todo) => void
  showMeetingLink?: boolean
}

/**
 * 单个 todo 渲染。pending_review 状态显示 ✓ 确认 + ✕ 删除；
 * open/done 状态显示 checkbox。
 */
export default function TodoRow({
  todo,
  onEdit,
  onConfirm,
  onDelete,
  showMeetingLink,
}: TodoRowProps): JSX.Element {
  const isPending = todo.status === 'pending_review'
  const isDone = todo.status === 'done'

  const tagBindings = useLiveQuery(
    () => db.tagBindings.where('target_type').equals('todo').and((b) => b.target_id === todo.id).toArray(),
    [todo.id],
    )
  const tagIds = useMemo(() => (tagBindings ?? []).map((b) => b.tag_id), [tagBindings])
  const tags = useLiveQuery(
    async () => tagIds.length === 0 ? [] : await db.tags.where('id').anyOf(tagIds).toArray(),
    [tagIds.join(',')],
  )

  const meeting = useLiveQuery(
    async () => todo.meeting_id ? await db.meetings.get(todo.meeting_id) : undefined,
    [todo.meeting_id ?? ''],
  )

  const toggleDone = async () => {
    const next: TodoStatus = isDone ? 'open' : 'done'
    await db.todos.update(todo.id, {
      status: next,
      updated_at: new Date().toISOString(),
      sync_version: todo.sync_version + 1,
    })
  }

  return (
    <div className={`group flex items-start gap-2 py-1.5 ${isDone ? 'opacity-60' : ''}`}>
      {isPending ? (
        <>
          <button
            type="button"
            aria-label="确认"
            onClick={() => onConfirm?.(todo)}
            className="mt-0.5 h-4 w-4 rounded border border-line-strong text-accent hover:border-accent flex items-center justify-center"
            title="确认加入待办"
          >✓</button>
          <button
            type="button"
            aria-label="删除"
            onClick={() => onDelete?.(todo)}
            className="mt-0.5 icon-btn !h-5 !w-5 text-text-3 hover:text-danger"
            title="删除"
          >✕</button>
        </>
      ) : (
        <button
          type="button"
          aria-label={isDone ? '取消完成' : '完成'}
          onClick={() => void toggleDone()}
          className={`mt-0.5 h-4 w-4 rounded border flex items-center justify-center text-[11px] ${
            isDone ? 'bg-accent border-accent text-accent-contrast' : 'border-line-strong hover:border-accent'
          }`}
        >
          {isDone ? '✓' : ''}
        </button>
      )}

      <div className="flex-1 min-w-0">
        <div className={`text-sm leading-snug ${isDone ? 'line-through text-text-3' : 'text-text-1'}`}>
          {todo.title}
        </div>
        {(todo.due_date || todo.assignee || (tags && tags.length > 0) || (showMeetingLink && meeting)) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-[11px] text-text-3">
            {todo.due_date && <span>📅 {fmtDate(todo.due_date)}</span>}
            {todo.assignee && <span>👤 {todo.assignee}</span>}
            {(tags ?? []).map((t) => (
              <span key={t.id} className="chip !py-0">#{t.name}</span>
            ))}
            {showMeetingLink && meeting && (
              <span className="text-accent/80">· {meeting.title}</span>
            )}
          </div>
        )}
        {todo.transcript_span?.quote && (
          <div className="mt-1 text-[11.5px] italic text-text-3 border-l-2 border-line pl-2 line-clamp-2">
            「{todo.transcript_span.quote}」
          </div>
        )}
      </div>

      {onEdit && (
        <button
          type="button"
          aria-label="编辑"
          onClick={() => onEdit(todo)}
          className="opacity-0 group-hover:opacity-100 transition-opacity icon-btn !h-7 !w-7"
          title="编辑"
        >⋯</button>
      )}
    </div>
  )
}

export function kindLabel(kind: TodoKind): string {
  if (kind === 'objective') return 'O'
  if (kind === 'kr') return 'KR'
  return 'T'
}