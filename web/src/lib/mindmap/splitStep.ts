import { db } from '../../db/db'
import { now, uid } from '../id'
import type { ID, Todo } from '../../types'

/** 非叶子「拆一步」：在其下新增空子任务（叶子候选） */
export async function addSplitChild(parent: Todo): Promise<ID> {
  const ts = now()
  const id = uid()
  const mapId = parent.map_id ?? parent.id
  await db.todos.add({
    id,
    kind: 'task',
    parent_id: parent.id,
    map_id: mapId,
    scope: null,
    title: '',
    status: 'open',
    source: 'manual',
    sort_order: Date.now(),
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    sync_version: 0,
  })
  return id
}
