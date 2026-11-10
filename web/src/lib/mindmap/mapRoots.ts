import { db } from '../../db/db'
import { now, uid } from '../id'
import type { ID, Meeting, Todo } from '../../types'
import { isLive } from './leaf'
import { listMapRootsFiltered } from './mapArchive'

export const INBOX_TITLE = 'Inbox'

/** 图根 = parent_id null 的活节点（含 Inbox、各项目根）；默认排除已归档 */
export async function listMapRoots(): Promise<Todo[]> {
  return listMapRootsFiltered({ archived: false })
}

export async function listArchivedMapRoots(): Promise<Todo[]> {
  return listMapRootsFiltered({ archived: true })
}

export function resolveMapId(parent: Todo | null | undefined, selfId?: ID): ID {
  if (!parent) return selfId ?? ''
  return parent.map_id ?? parent.id
}

/** 幂等：确保存在 Inbox 根图 */
export async function ensureInboxMap(): Promise<Todo> {
  const roots = await listMapRoots()
  const hit = roots.find((t) => t.title === INBOX_TITLE)
  if (hit) {
    if (!hit.map_id) await db.todos.update(hit.id, { map_id: hit.id })
    return (await db.todos.get(hit.id)) as Todo
  }
  const ts = now()
  const id = uid()
  const todo: Todo = {
    id,
    kind: 'task',
    parent_id: null,
    scope: null,
    title: INBOX_TITLE,
    status: 'open',
    source: 'manual',
    sort_order: 0,
    map_id: id,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    sync_version: 0,
  }
  await db.todos.add(todo)
  return todo
}

/** 在指定图下确保「本次会议 · {title}」分支 */
export async function ensureMeetingBranch(mapId: ID, meeting: Meeting): Promise<Todo> {
  const title = `本次会议 · ${meeting.title}`
  const all = await db.todos.toArray()
  const hit = all.find(
    (t) =>
      isLive(t) &&
      t.map_id === mapId &&
      t.parent_id === mapId &&
      t.meeting_id === meeting.id &&
      t.title === title,
  )
  if (hit) return hit
  const ts = now()
  const todo: Todo = {
    id: uid(),
    kind: 'task',
    parent_id: mapId,
    map_id: mapId,
    scope: null,
    title,
    status: 'open',
    source: 'meeting',
    meeting_id: meeting.id,
    sort_order: Date.now(),
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    sync_version: 0,
  }
  await db.todos.add(todo)
  return todo
}
