import { db } from '../db/db'
import { now, uid } from './id'
import type { ID, Note } from '../types'

/** 新建自由页面（非会议纪要）。空标题 = 空页邀请，由详情页聚焦标题输入。 */
export async function createPage(parentId: ID | null = null): Promise<ID> {
  const id = uid()
  const ts = now()
  const note: Note = {
    id,
    title: '',
    body_md: '',
    meeting_id: undefined,
    todo_ids: [],
    pinned: false,
    parent_id: parentId,
    sort_order: Date.now(),
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    sync_version: 0,
  }
  await db.notes.add(note)
  return id
}
