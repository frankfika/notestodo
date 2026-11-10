import { db } from '../../db/db'
import { now, uid } from '../id'
import type { Todo } from '../../types'
import { isLive } from './leaf'
import { ensureInboxMap } from './mapRoots'

/** Inbox 图下直接子节点（捕获流） */
export async function listInboxCaptures(): Promise<Todo[]> {
  const inbox = await ensureInboxMap()
  const all = await db.todos.toArray()
  return all
    .filter((t) => isLive(t) && t.map_id === inbox.id && t.parent_id === inbox.id)
    .sort((a, b) => b.sort_order - a.sort_order)
}

/** 一键捕获到 Inbox */
export async function captureToInbox(title: string): Promise<Todo> {
  const inbox = await ensureInboxMap()
  const ts = now()
  const id = uid()
  const todo: Todo = {
    id,
    kind: 'task',
    parent_id: inbox.id,
    map_id: inbox.id,
    scope: null,
    title: title.trim() || '未命名',
    status: 'open',
    source: 'manual',
    sort_order: Date.now(),
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    sync_version: 0,
  }
  await db.todos.add(todo)
  return todo
}
