import { db } from '../../db/db'
import type { ID, Meeting, Todo } from '../../types'
import { buildTask } from './createTask'
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

/**
 * 只读地找 Inbox 根图，找不到返回 undefined。
 *
 * liveQuery 的 querier 里不能写库（Dexie 会抛 "Readwrite transaction in
 * liveQuery context"），所以响应式读路径一律走这里；写只发生在
 * ensureInboxMap（调用方需在事务外调用，如 effect / 事件回调）。
 */
export async function findInboxMap(): Promise<Todo | undefined> {
  const roots = await listMapRoots()
  return roots.find((t) => t.title === INBOX_TITLE)
}

/**
 * 同一时刻只允许一个创建流程在跑。
 *
 * 并发调用方（React StrictMode 双挂载、多标签页）若各跑各的「找 + 建」，
 * 会在同一 tick 里都读到「还没有 Inbox」，于是各建一个 —— 图库里出现两个
 * 同名图根。Dexie 的表锁是 best-effort，不保证这里的 find-or-create 原子，
 * 所以再加一层单飞：后来的调用直接复用进行中的那个 Promise。
 */
let inboxCreating: Promise<Todo> | null = null

/**
 * 幂等：确保存在 Inbox 根图。
 *
 * find-or-create 必须**原子**（见上）。调用方必须在 liveQuery 之外调用
 * （liveQuery 里写库 Dexie 会抛 ReadOnly）。
 */
export async function ensureInboxMap(): Promise<Todo> {
  if (inboxCreating) return inboxCreating
  inboxCreating = db.transaction('rw', db.todos, async () => {
    const roots = await listMapRoots()
    const hit = roots.find((t) => t.title === INBOX_TITLE)
    if (hit) {
      if (!hit.map_id) await db.todos.update(hit.id, { map_id: hit.id })
      return (await db.todos.get(hit.id)) as Todo
    }
    const todo = buildTask({ title: INBOX_TITLE, placement: { root: true }, sortOrder: 0 })
    await db.todos.add(todo)
    return todo
  })
  try {
    return await inboxCreating
  } finally {
    inboxCreating = null
  }
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
  const todo = buildTask({
    title,
    placement: { mapId },
    source: 'meeting',
    meetingId: meeting.id,
  })
  await db.todos.add(todo)
  return todo
}
