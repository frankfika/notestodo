import { db } from '../../db/db'
import { now } from '../id'
import type { ID, Todo } from '../../types'
import { indexByParent, isLeafTodo, isLive } from './leaf'
import { INBOX_TITLE } from './mapRoots'
import { evictIfPresent } from './todaySlots'

export type MapRootListOpts = {
  /** true = 仅归档；false/缺省 = 仅活跃 */
  archived?: boolean
}

function isMapRoot(t: Todo): boolean {
  return isLive(t) && t.parent_id === null
}

/** 图根列表：默认不含归档；archived=true 仅归档 */
export async function listMapRootsFiltered(opts?: MapRootListOpts): Promise<Todo[]> {
  const all = await db.todos.toArray()
  const archived = opts?.archived === true
  return all
    .filter((t) => {
      if (!isMapRoot(t)) return false
      const isArch = Boolean(t.archived_at)
      return archived ? isArch : !isArch
    })
    .sort((a, b) => a.sort_order - b.sort_order)
}

/** 图上是否还有开放叶子 */
export async function mapHasOpenLeaves(mapId: ID): Promise<boolean> {
  const all = await db.todos.toArray()
  const byParent = indexByParent(all)
  return all.some(
    (t) =>
      t.map_id === mapId &&
      isLive(t) &&
      t.status === 'open' &&
      isLeafTodo(t, byParent),
  )
}

export type ArchiveResult = { ok: true } | { ok: false; reason: 'not_found' | 'inbox' | 'open_leaves' | 'already' }

export async function archiveMap(mapId: ID): Promise<ArchiveResult> {
  const root = await db.todos.get(mapId)
  if (!root || !isMapRoot(root)) return { ok: false, reason: 'not_found' }
  if (root.title === INBOX_TITLE) return { ok: false, reason: 'inbox' }
  if (root.archived_at) return { ok: false, reason: 'already' }
  if (await mapHasOpenLeaves(mapId)) return { ok: false, reason: 'open_leaves' }

  const ts = now()
  const all = await db.todos.toArray()
  const inMap = all.filter((t) => t.map_id === mapId && isLive(t))
  for (const t of inMap) {
    if (t.id !== mapId) await evictIfPresent(t.id)
  }
  await db.todos.update(mapId, { archived_at: ts, updated_at: ts, sync_version: root.sync_version + 1 })
  return { ok: true }
}

export type RestoreResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_archived' }

export async function restoreMap(mapId: ID): Promise<RestoreResult> {
  const root = await db.todos.get(mapId)
  if (!root || !isMapRoot(root)) return { ok: false, reason: 'not_found' }
  if (!root.archived_at) return { ok: false, reason: 'not_archived' }
  const ts = now()
  await db.todos.update(mapId, {
    archived_at: null,
    updated_at: ts,
    sync_version: root.sync_version + 1,
  })
  return { ok: true }
}

export function publicMapRoot(t: Todo): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    map_id: t.map_id ?? t.id,
    archived_at: t.archived_at ?? null,
    sort_order: t.sort_order,
    updated_at: t.updated_at,
  }
}
