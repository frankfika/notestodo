import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { useRecorder } from '../../state/recorder'
import { fmtClock, fmtDate, fmtDateTime, mod } from '../../lib/id'
import type { Meeting, MeetingStatus } from '../../types'
import EmptyState from '../../components/EmptyState'

function statusDot(s: MeetingStatus): string {
  switch (s) {
    case 'recording': return 'bg-danger'
    case 'processing':
    case 'transcribed':
    case 'summarizing': return 'bg-warning'
    case 'summarized': return 'bg-accent'
    case 'failed': return 'bg-danger'
  }
}

function statusLabel(s: MeetingStatus): string {
  switch (s) {
    case 'recording': return '录制中'
    case 'processing': return '转录中'
    case 'transcribed': return '转录完成'
    case 'summarizing': return '总结中'
    case 'summarized': return '已完成'
    case 'failed': return '失败'
  }
}

/**
 * 全部会议列表 + 选中预览。MVP：右栏展示简要 metadata + 跳详情按钮。
 */
export default function MeetingsPage(): JSX.Element {
  const meetings = useLiveQuery(
    () => db.meetings.orderBy('started_at').reverse().toArray(),
    [],
  ) ?? []
  const goMeeting = useUI((s) => s.goMeeting)
  const start = useRecorder((s) => s.start)

  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 自动选中最近一个
  const activeId = selectedId ?? meetings[0]?.id ?? null
  const active = useLiveQuery(
    async () => activeId ? await db.meetings.get(activeId) : undefined,
    [activeId],
  )

  // 按日期分组
  const grouped = useMemo(() => {
    const map = new Map<string, Meeting[]>()
    for (const m of meetings) {
      const day = m.started_at.slice(0, 10)
      const list = map.get(day) ?? []
      list.push(m)
      map.set(day, list)
    }
    return [...map.entries()]
  }, [meetings])

  return (
    <div className="h-full flex">
      {/* 列表 */}
      <div className="w-[300px] shrink-0 border-r border-line overflow-y-auto">
        <div className="sticky top-0 z-10 bg-bg/95 backdrop-blur px-5 py-4 border-b border-line flex items-center">
          <h1 className="text-sm font-semibold text-text-1">会议</h1>
          <span className="ml-2 text-[11px] text-text-3 tabular-nums">{meetings.length}</span>
          <button
            onClick={() => void start()}
            className="ml-auto btn-primary text-xs h-7 px-2.5"
          >● 新建录音</button>
        </div>

        {meetings.length === 0 ? (
          <EmptyState
            icon="◌"
            title="还没有会议"
            hint={`按 ${mod()}⇧R 或点右上角立刻开始。`}
            action={
              <button onClick={() => void start()} className="btn-primary h-8 text-xs">● 开始录音</button>
            }
          />
        ) : (
          grouped.map(([day, list]) => (
            <div key={day} className="py-1">
              <div className="px-5 py-1.5 text-[11px] font-semibold tracking-widest text-text-3">
                {fmtDate(day, true)}
              </div>
              <ul>
                {list.map((m) => {
                  const active = activeId === m.id
                  return (
                    <li key={m.id}>
                      <button
                        onClick={() => setSelectedId(m.id)}
                        className={`w-full flex items-center gap-2.5 px-5 py-2 text-left text-sm transition-colors ${
                          active ? 'bg-bg-overlay' : ''
                        } hover:bg-bg-overlay/50`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDot(m.status)}`} />
                        <span className="flex-1 min-w-0 truncate text-text-1">{m.title}</span>
                        <span className="text-[11px] text-text-3 font-mono tabular-nums shrink-0">
                          {fmtClock(m.audio.duration_ms)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>

      {/* 预览 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {active ? (
          <MeetingPreview meeting={active} onOpen={() => goMeeting(active.id)} />
        ) : (
          <div className="h-full flex items-center justify-center">
            <EmptyState icon="◐" title="选择左侧一条会议" hint="预览卡片；点条目进入完整详情。" />
          </div>
        )}
      </div>
    </div>
  )
}

function MeetingPreview({ meeting, onOpen }: { meeting: Meeting; onOpen: () => void }): JSX.Element {
  const transcript = useLiveQuery(
    () => db.transcripts.where('meeting_id').equals(meeting.id).first(),
    [meeting.id],
  )
  const summary = useLiveQuery(
    () => db.summaries.where('meeting_id').equals(meeting.id).first(),
    [meeting.id],
  )
  const pendingTodos = useLiveQuery(
    () => db.todos.where('meeting_id').equals(meeting.id).and((x) => x.status === 'pending_review').count(),
    [meeting.id],
  ) ?? 0

  return (
    <div className="max-w-[720px] mx-auto px-8 py-10">
      <div className="flex items-center gap-2 mb-3">
        <span className={`h-2 w-2 rounded-full ${statusDot(meeting.status)}`} />
        <span className="text-xs text-text-3">{statusLabel(meeting.status)}</span>
        <span className="ml-auto text-xs text-text-3">{fmtDateTime(meeting.started_at)}</span>
      </div>
      <h2 className="text-2xl font-semibold text-text-1 mb-1">{meeting.title}</h2>
      <div className="flex items-center gap-3 text-xs text-text-3 mb-6">
        <span>⏱ {fmtClock(meeting.audio.duration_ms)}</span>
        <span>·</span>
        <span>音频 {meeting.audio.format} · {meeting.audio.chunk_count} 片</span>
        {meeting.audio.size_bytes > 0 && (
          <>
            <span>·</span>
            <span>{(meeting.audio.size_bytes / (1024 * 1024)).toFixed(1)} MB</span>
          </>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 mb-8">
        <Stat label="转录" value={transcript ? `${transcript.segments.length} 段` : '—'} />
        <Stat label="纪要" value={summary ? '已生成' : '—'} />
        <Stat label="待审待办" value={String(pendingTodos)} />
      </div>

      {summary ? (
        <div className="card p-5 mb-6">
          <div className="section-title mb-2">摘要预览</div>
          <p className="text-sm text-text-2 line-clamp-4 whitespace-pre-wrap">{summary.content_md}</p>
        </div>
      ) : (
        <div className="card p-5 mb-6">
          <div className="section-title mb-2">尚未生成纪要</div>
          <p className="text-sm text-text-3">在详情页可触发总结，或换模板重新生成。</p>
        </div>
      )}

      <button onClick={onOpen} className="btn-primary h-10 px-5">打开详情 →</button>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="card p-3">
      <div className="text-[11px] text-text-3 tracking-wider uppercase">{label}</div>
      <div className="text-base text-text-1 font-medium mt-1">{value}</div>
    </div>
  )
}