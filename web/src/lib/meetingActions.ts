import { db } from '../db/db'
import { now } from './id'
import type { Meeting } from '../types'

export async function renameMeeting(m: Meeting, title: string): Promise<void> {
  const v = title.trim()
  if (!v || v === m.title) return
  await db.meetings.update(m.id, { title: v, updated_at: now() })
}

/** 级联硬删：会议 + 转录/纪要/音频/待办/对话/速记/待办绑定/置顶卡 + 关联纪要笔记 */
export async function deleteMeetingCascade(m: Meeting): Promise<void> {
  const todoIds = await db.todos.where('meeting_id').equals(m.id).primaryKeys()
  await db.meetings.delete(m.id)
  await db.audioChunks.where('meeting_id').equals(m.id).delete()
  await db.transcripts.where('meeting_id').equals(m.id).delete()
  await db.summaries.where('meeting_id').equals(m.id).delete()
  await db.todos.where('meeting_id').equals(m.id).delete()
  await db.chatMessages.where('meeting_id').equals(m.id).delete()
  await db.scribbles.where('meeting_id').equals(m.id).delete()
  await db.pinnedAssistCards.where('meeting_id').equals(m.id).delete()
  await db.tagBindings.where('[target_type+target_id]').equals(['meeting', m.id]).delete()
  if (todoIds.length > 0) {
    await db.tagBindings.where('[target_type+target_id]').anyOf(todoIds.map((id): [string, string] => ['todo', String(id)])).delete()
  }
  if (m.note_id) await db.notes.delete(m.note_id)
}
