import { db } from '../../db/db'
import { now, uid } from '../id'
import type { ID, Todo } from '../../types'

/**
 * 「创建任务」的唯一入口。
 *
 * 历史上 TodosPage / TodayPage / todoRowOps / inboxCapture / convert / localApi
 * 各自手拼 Todo 字面量，字段默认值（map_id / assignee / due_date / sort_order）
 * 各给各的 —— 两次「快速添加建错地方」的事故都源于此。收口到这里：
 * 字段默认值只有一份，调用方只说「挂在哪」。
 */

/** 落点三选一：挂到某节点下 / 挂进某张图（图根的直接叶子）/ 独立成根 */
export type TaskPlacement =
  | { under: Todo }
  | { mapId: ID }
  | { parentId: ID; mapId: ID }
  | { root: true }

export type CreateTaskOpts = {
  title: string
  id?: ID
  placement?: TaskPlacement
  dueDate?: string
  assignee?: string
  source?: Todo['source']
  meetingId?: ID
  sortOrder?: number
  status?: Todo['status']
}

function place(
  pl: TaskPlacement,
  selfId: ID,
): { parentId: ID | null; mapId: ID } {
  if ('under' in pl) return { parentId: pl.under.id, mapId: pl.under.map_id ?? pl.under.id }
  if ('parentId' in pl) return { parentId: pl.parentId, mapId: pl.mapId }
  if ('mapId' in pl) return { parentId: pl.mapId, mapId: pl.mapId }
  return { parentId: null, mapId: selfId }
}

/** 纯构造（不落库），供需要先拿到对象的场景（如 convert 的 ME 操作补丁） */
export function buildTask(opts: CreateTaskOpts): Todo {
  const ts = now()
  const id = opts.id ?? uid()
  const { parentId, mapId } = place(opts.placement ?? { root: true }, id)
  return {
    id,
    kind: 'task',
    parent_id: parentId,
    map_id: mapId,
    scope: null,
    title: opts.title,
    status: opts.status ?? 'open',
    source: opts.source ?? 'manual',
    sort_order: opts.sortOrder ?? Date.now(),
    ...(opts.dueDate ? { due_date: opts.dueDate } : {}),
    ...(opts.assignee ? { assignee: opts.assignee } : {}),
    ...(opts.meetingId ? { meeting_id: opts.meetingId } : {}),
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    sync_version: 0,
  }
}

export async function createTask(opts: CreateTaskOpts): Promise<Todo> {
  const todo = buildTask(opts)
  await db.todos.add(todo)
  return todo
}
