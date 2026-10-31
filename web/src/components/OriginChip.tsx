import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { useUI } from '../state/ui'
import type { Todo } from '../types'

/** 任务来源溯源 chip：来自笔记 → 跳笔记；来自会议 → 跳会议详情 */
export default function OriginChip({ t }: { t: Todo }): JSX.Element | null {
  const goNote = useUI((s) => s.goNote)
  const goMeeting = useUI((s) => s.goMeeting)
  const note = useLiveQuery(
    () => (t.origin_note_id ? db.notes.get(t.origin_note_id) : undefined),
    [t.origin_note_id],
  )
  const meeting = useLiveQuery(
    () => (t.meeting_id ? db.meetings.get(t.meeting_id) : undefined),
    [t.meeting_id],
  )

  const chips: { key: string; label: string; go: () => void }[] = []
  if (t.origin_note_id && note) {
    chips.push({ key: 'note', label: `✎ ${note.title || '无标题'}`, go: () => goNote(note.id) })
  }
  if (t.meeting_id && meeting) {
    chips.push({ key: 'meeting', label: `● ${meeting.title}`, go: () => goMeeting(meeting.id) })
  }
  if (chips.length === 0) return null

  return (
    <>
      {chips.map((c) => (
        <button
          key={c.key}
          onClick={(e) => { e.stopPropagation(); c.go() }}
          title={`打开来源：${c.label.slice(2)}`}
          className="px-1.5 py-0.5 rounded bg-bg-overlay text-text-3 text-[11px] truncate max-w-[140px] hover:text-accent transition-colors shrink-0"
        >{c.label}</button>
      ))}
    </>
  )
}
