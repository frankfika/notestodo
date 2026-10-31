import { now, uid } from './id'
import type { ID, TranscriptSegment } from '../types'
import type { ShibeiDB } from '../db/db'

/**
 * 导入外部会议转录文本（腾讯会议导出 / 飞书妙记导出的 txt）。
 * 建 Meeting(source, status='transcribed', 音频空壳) + 同名 Note + Transcript。
 * 解析格式：
 *   HH:MM:SS 说话人: 文本        （腾讯会议）
 *   [00:12:34] 名字 文本          （带括号时间戳）
 *   纯文本行                       （无时间戳 → t_ms 顺序估 5s/段，speaker '未知'）
 * 解析不出的行拼进上一段。
 */
export async function importTranscriptText(
  dbi: ShibeiDB,
  opts: { title: string; source: 'tencent' | 'feishu'; text: string },
): Promise<ID> {
  const segments = parseSegments(opts.text)
  if (segments.length === 0) throw new Error('没有可导入的内容')

  const ts = now()
  const noteId = uid()
  await dbi.notes.add({
    id: noteId, title: opts.title, body_md: '', todo_ids: [], pinned: false, parent_id: null,
    created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
  })

  const meetingId = uid()
  await dbi.meetings.add({
    id: meetingId,
    title: opts.title,
    source: opts.source,
    status: 'transcribed',
    started_at: ts,
    audio: { format: '', codec: '', duration_ms: segments[segments.length - 1].end_ms, chunk_count: 0, size_bytes: 0, gaps: [] },
    note_id: noteId,
    created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
  })
  await dbi.notes.update(noteId, { meeting_id: meetingId })

  await dbi.transcripts.add({
    id: uid(),
    meeting_id: meetingId,
    language: 'zh',
    engine: `import-${opts.source}`,
    segments,
    speaker_names: {},
    created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
  })
  return meetingId
}

function toMs(h: string, m: string, s: string): number {
  return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000
}

// ponytail: 保守解析，只认两种常见时间戳格式；其余拼进上一段
export function parseSegments(text: string): TranscriptSegment[] {
  const reTencent = /^(\d{1,2}):(\d{2}):(\d{2})\s+([^:：]{1,20})[:：]\s*(.+)$/
  const reBracket = /^\[(\d{1,2}):(\d{2}):(\d{2})\]\s*(\S{1,20})?\s*(.+)$/
  const segments: TranscriptSegment[] = []
  let est = 0 // 无时间戳行的估算游标

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let m = reTencent.exec(line)
    if (m) {
      est = toMs(m[1], m[2], m[3])
      segments.push({ start_ms: est, end_ms: est + 5000, speaker_label: m[4].trim(), text: m[5].trim() })
      est += 5000
      continue
    }
    m = reBracket.exec(line)
    if (m) {
      est = toMs(m[1], m[2], m[3])
      segments.push({ start_ms: est, end_ms: est + 5000, speaker_label: (m[4] ?? '未知').trim(), text: m[5].trim() })
      est += 5000
      continue
    }
    // 纯文本行：拼进上一段，没有上一段就新开一段
    const last = segments[segments.length - 1]
    if (last) {
      last.text += '\n' + line
      last.end_ms += 5000
      est = last.end_ms
    } else {
      segments.push({ start_ms: est, end_ms: est + 5000, speaker_label: '未知', text: line })
      est += 5000
    }
  }
  return segments
}
