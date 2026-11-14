import { db } from '../../db/db'
import { now } from '../id'
import { subtreeIds } from '../okr'
import type { ID, Todo } from '../../types'

export function resolveMapForParent(
  parentId: ID | null,
  byId: Map<string, Todo>,
  selfId: ID,
): ID {
  if (!parentId) return selfId
  const parent = byId.get(parentId)
  if (!parent) return selfId
  return parent.map_id ?? parent.id
}

/**
 * 结构移动必须和 map 归属一起变化。
 *
 * 只改 parent_id 会让「任务树位置」和「脑图归属」裂开：
 * 行已经挂到新父节点下了，画布却还把它留在旧图里。这里统一收口，
 * 移根 / 缩进 / 拖拽都走同一套规则，并把整棵子树的 map_id 一起带过去。
 */
export async function moveTodoWithMapSync(
  todo: Todo,
  opts: { parentId: ID | null; sortOrder: number },
  all: Todo[],
): Promise<void> {
  const byId = new Map(all.map((t) => [t.id, t]))
  const nextMapId = resolveMapForParent(opts.parentId, byId, todo.id)
  const ts = now()
  const ids = [...subtreeIds(todo.id, all)]

  await db.transaction('rw', db.todos, async () => {
    await db.todos.update(todo.id, {
      parent_id: opts.parentId,
      map_id: nextMapId,
      sort_order: opts.sortOrder,
      updated_at: ts,
      sync_version: todo.sync_version + 1,
    })
    for (const sid of ids) {
      if (sid === todo.id) continue
      const sub = byId.get(sid)
      if (!sub || sub.map_id === nextMapId) continue
      await db.todos.update(sid, {
        map_id: nextMapId,
        updated_at: ts,
        sync_version: sub.sync_version + 1,
      })
    }
  })
}
