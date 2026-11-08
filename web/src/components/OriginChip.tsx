import { useUI } from '../state/ui'
import type { Todo } from '../types'

/**
 * 任务来源溯源 chip：来自笔记 → 跳笔记；来自会议 → 跳会议详情。
 * 标题由页面级 useOriginTitles 提供（不再自己挂表级 liveQuery）。
 */
export default function OriginChip({ t, noteTitle, meetingTitle }: {
  t: Todo
  noteTitle?: string
  meetingTitle?: string
}): JSX.Element | null {
  const goNote = useUI((s) => s.goNote)
  const goMeeting = useUI((s) => s.goMeeting)

  const chips: { key: string; label: string; go: () => void }[] = []
  if (t.origin_note_id && noteTitle) {
    chips.push({ key: 'note', label: `✎ ${noteTitle}`, go: () => goNote(t.origin_note_id!) })
  }
  if (t.meeting_id && meetingTitle) {
    chips.push({ key: 'meeting', label: `● ${meetingTitle}`, go: () => goMeeting(t.meeting_id!) })
  }
  if (chips.length === 0) return null

  return (
    <>
      {chips.map((c) => (
        <button
          key={c.key}
          onClick={(e) => { e.stopPropagation(); c.go() }}
          title={`打开来源：${c.label.slice(2)}`}
          className="px-1.5 py-0.5 rounded border border-line bg-bg-overlay text-text-2 text-[11px] truncate max-w-[140px] hover:text-accent hover:border-accent transition-colors shrink-0"
        >{c.label}</button>
      ))}
    </>
  )
}
