import { db } from '../db/db'
import { now } from './id'
import type { Meeting } from '../types'

export async function renameMeeting(m: Meeting, title: string): Promise<void> {
  const v = title.trim()
  if (!v || v === m.title) return
  await db.meetings.update(m.id, { title: v, updated_at: now() })
}

/** 级联硬删：会议 + 转录/纪要/音频/待办/对话/速记/待办绑定/置顶卡 + 关联纪要笔记。
 *  整段一个事务：中途任一步失败全部回滚 —— 旧实现会议行最先删，留下孤儿数据且无从重试。 */
export async function deleteMeetingCascade(m: Meeting): Promise<void> {
  await db.transaction(
    'rw',
    [db.meetings, db.audioChunks, db.transcripts, db.summaries, db.todos, db.chatMessages, db.scribbles, db.pinnedAssistCards, db.tagBindings, db.notes, db.kv],
    async () => {
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
      // 实时字幕 / 纪要模板的 kv 键按 meeting id 命名，不删会永久残留
      await db.kv.delete(`live_caption_${m.id}`)
      await db.kv.delete(`meeting_template_${m.id}`)
      if (m.note_id) await db.notes.update(m.note_id, { deleted_at: now(), updated_at: now() })
    },
  )
}
