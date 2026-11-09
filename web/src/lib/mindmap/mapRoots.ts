import { db } from '../../db/db'
import { now, uid } from '../id'
import type { ID, Meeting, Todo } from '../../types'
import { isLive } from './leaf'

export const INBOX_TITLE = 'Inbox'

export function isMapRoot(t: Todo): boolean {
  return isLive(t) && t.parent_id === null
}

function isArchivedRoot(t: Todo): boolean {
  return Boolean(t.map_archived_at)
}

/** 图根 = parent_id null 的活节点；默认不含已归档 */
export async function listMapRoots(opts?: { includeArchived?: boolean }): Promise<Todo[]> {
  const all = await db.todos.toArray()
  return all
    .filter((t) => {
      if (!isMapRoot(t)) return false
      if (!opts?.includeArchived && isArchivedRoot(t)) return false
      return true
    })
    .sort((a, b) => a.sort_order - b.sort_order)
}

export async function listArchivedMapRoots(): Promise<Todo[]> {
  const all = await db.todos.toArray()
  return all
    .filter((t) => isMapRoot(t) && isArchivedRoot(t))
    .sort((a, b) => (b.map_archived_at ?? '').localeCompare(a.map_archived_at ?? ''))
}

/** 归档图根（不可归档 Inbox） */
export async function archiveMapRoot(mapId: ID): Promise<{ ok: true } | { ok: false; reason: string }> {
  const root = await db.todos.get(mapId)
  if (!root || !isMapRoot(root)) return { ok: false, reason: 'not_root' }
  if (root.title === INBOX_TITLE) return { ok: false, reason: 'inbox' }
  if (isArchivedRoot(root)) return { ok: true }
  const ts = now()
  await db.todos.update(mapId, { map_archived_at: ts, updated_at: ts, sync_version: root.sync_version + 1 })
  return { ok: true }
}

export async function unarchiveMapRoot(mapId: ID): Promise<{ ok: true } | { ok: false; reason: string }> {
  const root = await db.todos.get(mapId)
  if (!root || !isMapRoot(root)) return { ok: false, reason: 'not_root' }
  if (!isArchivedRoot(root)) return { ok: true }
  const ts = now()
  await db.todos.update(mapId, {
    map_archived_at: undefined,
    updated_at: ts,
    sync_version: root.sync_version + 1,
  })
  return { ok: true }
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
