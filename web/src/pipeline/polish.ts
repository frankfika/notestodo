import { db } from '../db/db'
import { getSettings } from '../db/settings'
import { callLLM } from '../llm/client'
import { buildPolishMessages, scribblesToMarkdown, stripFence } from '../llm/prompts'
import { now, uid } from '../lib/id'

/**
 * Polish：速记 + 转录 → 完整 Markdown 笔记，写入会议关联的 Note。
 * 手动「重新整理」与会后自动整理共用这一份实现。
 */
export async function runPolish(meetingId: string): Promise<void> {
  const meeting = await db.meetings.get(meetingId)
  if (!meeting) throw new Error(`Meeting ${meetingId} not found`)
  const settings = await getSettings()
  if (!settings.llm_api_key) throw new Error('请先在「设置」页填 LLM API Key')
  const rows = await db.scribbles.where('meeting_id').equals(meetingId).sortBy('created_at')
  const transcript = await db.transcripts.where('meeting_id').equals(meetingId).first()
  const md = stripFence(await callLLM(
    settings,
    buildPolishMessages(meeting, scribblesToMarkdown(rows), transcript),
    { maxTokens: 3072, temperature: 0.3 },
  ))
  if (!md) throw new Error('模型返回为空')
  const ts = now()
  if (meeting.note_id && await db.notes.get(meeting.note_id)) {
    await db.notes.update(meeting.note_id, { body_md: md, updated_at: ts })
  } else {
    const id = uid()
    await db.notes.add({
      id, title: meeting.title, body_md: md, meeting_id: meetingId, todo_ids: [], pinned: false,
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
    await db.meetings.update(meetingId, { note_id: id, updated_at: ts })
  }
}

/**
 * 会后自动整理（Foresight：散会即得笔记，不用再点按钮）。
 * 已有笔记（用户手动整理/写过）则不覆盖；没配 Key 静默跳过；失败只记日志，不影响纪要管线。
 */
export async function autoPolish(meetingId: string): Promise<void> {
  const meeting = await db.meetings.get(meetingId)
  if (!meeting || meeting.note_id) return
  const settings = await getSettings()
  if (!settings.llm_api_key) return
  await runPolish(meetingId).catch((e) => console.warn('自动整理失败', e))
}
