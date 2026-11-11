import { db } from '../../db/db'
import type { Todo } from '../../types'
import { createTask } from './createTask'
import { isLive } from './leaf'
import { ensureInboxMap, findInboxMap } from './mapRoots'

/**
 * Inbox 图下直接子节点（捕获流）。
 * 只读 —— 可安全用于 liveQuery；Inbox 图本身由 ensureInboxMap 在事务外创建。
 */
export async function listInboxCaptures(): Promise<Todo[]> {
  const inbox = await findInboxMap()
  if (!inbox) return []
  const all = await db.todos.toArray()
  return all
    .filter((t) => isLive(t) && t.map_id === inbox.id && t.parent_id === inbox.id)
    .sort((a, b) => b.sort_order - a.sort_order)
}

/** 一键捕获到 Inbox */
export async function captureToInbox(title: string): Promise<Todo> {
  const inbox = await ensureInboxMap()
  return createTask({ title: title.trim() || '未命名', placement: { under: inbox } })
}
