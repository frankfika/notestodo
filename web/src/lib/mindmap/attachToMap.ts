import { db } from '../../db/db'
import { now } from '../id'
import type { ID, Meeting, Todo } from '../../types'
import { ensureInboxMap, ensureMeetingBranch, listMapRoots } from './mapRoots'
import type { ConfirmTarget } from './types'

const LAST_MAP_KEY = 'mindmap.last_map_id'

export async function getLastMapId(): Promise<ID | null> {
  const row = await db.kv.get(LAST_MAP_KEY)
  const v = row?.value
  return typeof v === 'string' ? v : null
}

export async function setLastMapId(mapId: ID): Promise<void> {
  await db.kv.put({ key: LAST_MAP_KEY, value: mapId })
}

/** 默认确认目标：上次图或 Inbox + 本次会议分支 */
export async function defaultConfirmTarget(
  meeting: Meeting,
  lastMapId?: ID | null,
): Promise<ConfirmTarget> {
  const active = await listMapRoots()
  const activeIds = new Set(active.map((r) => r.id))
  let mapId = lastMapId ?? (await getLastMapId()) ?? null
  if (!mapId || !activeIds.has(mapId)) mapId = (await ensureInboxMap()).id
  const branch = await ensureMeetingBranch(mapId, meeting)
  const root = await db.todos.get(mapId)
  const mapTitle = root?.title ?? 'Inbox'
  return {
    mapId,
    parentId: branch.id,
    label: `${mapTitle} / ${branch.title}`,
  }
}

/** 会议/笔记确认：pending_review→open，挂到指定图节点 */
export async function attachTaskToMap(
  t: Todo,
  target: { mapId: ID; parentId: ID },
): Promise<void> {
  await db.todos.update(t.id, {
    status: t.status === 'pending_review' ? 'open' : t.status,
    parent_id: target.parentId,
    map_id: target.mapId,
    scope: null,
    updated_at: now(),
    sync_version: t.sync_version + 1,
  })
  await setLastMapId(target.mapId)
}
