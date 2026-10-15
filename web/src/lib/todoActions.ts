import { db } from '../db/db'
import { now } from './id'
import type { Todo } from '../types'

/** 确认 / 归位一条 task：挂到 KR（null = Inbox），状态置 open。会议待办确认与 Inbox 整理共用。 */
export async function attachTask(t: Todo, kr: Todo | null): Promise<void> {
  await db.todos.update(t.id, {
    status: t.status === 'pending_review' ? 'open' : t.status,
    parent_id: kr?.id ?? null,
    scope: kr?.scope ?? null,
    updated_at: now(),
    sync_version: t.sync_version + 1,
  })
}

/** 丢弃会议误提取的待办（pending_review 尚未进入任务体系，直接删） */
export async function discardTask(t: Todo): Promise<void> {
  await db.todos.delete(t.id)
}
