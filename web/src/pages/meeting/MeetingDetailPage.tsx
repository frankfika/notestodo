import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { fmtClock, fmtDateTime, now, uid } from '../../lib/id'
import type { Meeting, MeetingStatus, SummaryTemplate, Todo } from '../../types'
import MarkdownView from '../../components/MarkdownView'
import EmptyState from '../../components/EmptyState'
import TodoRow from '../../components/TodoRow'
import { runSummarizePipeline } from '../../pipeline/summarize'

type Tab = 'summary' | 'todos' | 'transcript' | 'audio'

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

function statusTone(s: MeetingStatus): string {
  switch (s) {
    case 'recording': return 'border-danger/40 text-danger bg-danger/8'
    case 'processing':
    case 'transcribed':
    case 'summarizing': return 'border-warning/40 text-warning bg-warning/8'
    case 'summarized': return 'border-accent/40 text-accent bg-accent/8'
    case 'failed': return 'border-danger/40 text-danger bg-danger/8'
  }
}

/**
 * 会议详情：标题 + 状态 + Tab(纪要/待办/转录/录音)
 * - 待办 Tab 仅在有 pending_review 的 todo 时出现
 * - 录音 Tab 从 audioChunks 拼 blob URL
 */
export default function MeetingDetailPage(): JSX.Element {
  const meetingId = useUI((s) => s.meetingId)
  const goMeetings = useUI((s) => s.goMeetings)

  const meeting = useLiveQuery(
    async () => meetingId ? await db.meetings.get(meetingId) : undefined,
    [meetingId ?? ''],
  )

  if (!meetingId || !meeting) {
    return (
      <div className="h-full flex items-center justify-center">
        <EmptyState
          icon="◐"
          title="没有选中的会议"
          hint="回到会议列表选择一条，或按 ⌘⇧R 新建一场。"
          action={
            <button onClick={goMeetings} className="btn-outline h-8 text-xs">→ 会议列表</button>
          }
        />
      </div>
    )
  }

  return <MeetingDetailInner meeting={meeting} />
}

function MeetingDetailInner({ meeting }: { meeting: Meeting }): JSX.Element {
  const transcript = useLiveQuery(
    () => db.transcripts.where('meeting_id').equals(meeting.id).first(),
    [meeting.id],
  )
  const summary = useLiveQuery(
    () => db.summaries.where('meeting_id').equals(meeting.id).first(),
    [meeting.id],
  )
  const reviewTodos = useLiveQuery(
    () => db.todos.where('meeting_id').equals(meeting.id).and((x) => x.status === 'pending_review').toArray(),
    [meeting.id],
  ) ?? []
  const templates = useLiveQuery(
    () => db.templates.toArray(),
    [],
  ) ?? []

  const [tab, setTab] = useState<Tab>('summary')
  const [highlightStartMs, setHighlightStartMs] = useState<number | null>(null)

  const jumpToTranscript = (t: Todo): void => {
    if (t.transcript_span?.start_ms != null) {
      setHighlightStartMs(t.transcript_span.start_ms)
    } else if (t.meeting_id) {
      setHighlightStartMs(0)
    }
    setTab('transcript')
  }

  // 阶段推导
  const hasTranscript = Boolean(transcript && transcript.segments.length > 0)
  const hasSummary = meeting.status === 'summarized' || Boolean(summary)
  const stepTranscriptDone = hasTranscript
  const stepSummaryDone = hasSummary
  const stepTodosDone = reviewTodos.every((t) => t.status !== 'pending_review')

  // 如果待办 Tab 没有内容，自动跳走
  useEffect(() => {
    if (tab === 'todos' && reviewTodos.length === 0) setTab('summary')
  }, [tab, reviewTodos.length])

  const showTodosTab = reviewTodos.length > 0

  async function confirmTodo(t: Todo): Promise<void> {
    await db.todos.update(t.id, {
      status: 'open',
      updated_at: now(),
      sync_version: t.sync_version + 1,
    })
  }
  async function deleteTodo(t: Todo): Promise<void> {
    await db.todos.delete(t.id)
  }
  async function confirmAll(): Promise<void> {
    const ts = now()
    for (const t of reviewTodos) {
      await db.todos.update(t.id, { status: 'open', updated_at: ts, sync_version: t.sync_version + 1 })
    }
  }

  async function rerunWith(templateId: string): Promise<void> {
    // 记录选中的模板到 KVK，触发重生成
    await db.kv.put({ key: `meeting_template_${meeting.id}`, value: templateId })
    await runSummarizePipeline(meeting.id).catch((e) => {
      console.error('重新生成失败', e)
    })
  }

  async function deleteMeeting(): Promise<void> {
    if (!window.confirm(`删除「${meeting.title}」？所有关联转录、纪要、待办都会被清理。`)) return
    await db.meetings.delete(meeting.id)
    await db.audioChunks.where('meeting_id').equals(meeting.id).delete()
    await db.transcripts.where('meeting_id').equals(meeting.id).delete()
    await db.summaries.where('meeting_id').equals(meeting.id).delete()
    await db.todos.where('meeting_id').equals(meeting.id).delete()
    if (meeting.note_id) await db.notes.delete(meeting.note_id)
    useUI.getState().goMeetings()
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-6 py-8">
        {/* 顶部 */}
        <div className="flex items-start gap-3 mb-2">
          <button
            onClick={useUI.getState().goMeetings}
            className="icon-btn -ml-2 mt-0.5"
            title="返回列表"
            aria-label="返回"
          >←</button>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold text-text-1 truncate">{meeting.title}</h1>
            <div className="flex items-center gap-3 text-xs text-text-3 mt-1">
              <span>{fmtDateTime(meeting.started_at)}</span>
              <span>·</span>
              <span>⏱ {fmtClock(meeting.audio.duration_ms)}</span>
            </div>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-md border ${statusTone(meeting.status)}`}>
            {statusLabel(meeting.status)}
          </span>
        </div>

        {/* 操作行 */}
        <div className="flex items-center gap-2 mt-3 mb-4">
          <RerunDropdown templates={templates} onPick={rerunWith} />
          <button
            onClick={() => window.alert('对话功能即将推出')}
            className="btn-outline text-xs h-8"
          >对话</button>
          <button onClick={() => void deleteMeeting()} className="btn-danger text-xs h-8 ml-auto">
            删除
          </button>
        </div>

        {/* Tab 栏 */}
        <div className="border-b border-line flex items-center gap-1 mb-6 text-sm">
          <TabBtn active={tab === 'summary'} onClick={() => setTab('summary')}>纪要</TabBtn>
          {showTodosTab && (
            <TabBtn active={tab === 'todos'} onClick={() => setTab('todos')}>
              待办 <span className="ml-1 text-[11px] text-text-3">{reviewTodos.length}</span>
            </TabBtn>
          )}
          <TabBtn active={tab === 'transcript'} onClick={() => setTab('transcript')}>转录</TabBtn>
          <TabBtn active={tab === 'audio'} onClick={() => setTab('audio')}>录音</TabBtn>
        </div>

        {/* 内容 */}
        {tab === 'summary' && (
          <SummaryTab
            meeting={meeting}
            transcript={transcript}
            summary={summary}
            stepTranscriptDone={stepTranscriptDone}
            stepSummaryDone={stepSummaryDone}
            stepTodosDone={stepTodosDone}
          />
        )}
        {tab === 'todos' && showTodosTab && (
          <TodosTab
            todos={reviewTodos}
            onConfirm={confirmTodo}
            onDelete={deleteTodo}
            onConfirmAll={confirmAll}
            onJumpToTranscript={jumpToTranscript}
          />
        )}
        {tab === 'transcript' && (
          <TranscriptTab transcriptId={meeting.id} highlightStartMs={highlightStartMs} />
        )}
        {tab === 'audio' && <AudioTab meetingId={meeting.id} />}
      </div>
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2.5 -mb-px border-b-2 text-sm transition-colors ${
        active ? 'border-accent text-text-1' : 'border-transparent text-text-3 hover:text-text-1'
      }`}
    >{children}</button>
  )
}

function RerunDropdown({ templates, onPick }: { templates: SummaryTemplate[]; onPick: (id: string) => void | Promise<void> }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="btn-outline text-xs h-8">
        ▾ 重新生成
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <ul className="absolute z-40 left-0 mt-1 min-w-[200px] card p-1 text-sm shadow-xl">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => { setOpen(false); void onPick(t.id) }}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-bg-overlay text-text-1"
                >
                  <span className="mr-1.5">{t.icon}</span>
                  {t.name}
                  {t.builtin && <span className="ml-1 text-[10px] uppercase tracking-wider text-text-3">内置</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

// ── 纪要 Tab ──────────────────────────────────────────────────────
function SummaryTab({
  meeting, transcript, summary, stepTranscriptDone, stepSummaryDone, stepTodosDone,
}: {
  meeting: Meeting
  transcript: { segments: { speaker_label: string; text: string }[] } | undefined
  summary: { content_md: string } | undefined
  stepTranscriptDone: boolean
  stepSummaryDone: boolean
  stepTodosDone: boolean
}): JSX.Element {
  const hasSummary = meeting.status === 'summarized' || Boolean(summary)

  return (
    <div>
      {!hasSummary && (
        <div className="card p-5 mb-6">
          <div className="section-title mb-3">进度</div>
          <ol className="space-y-2 text-sm">
            <Step done={stepTranscriptDone} label="转录" />
            <Step done={stepSummaryDone} label="总结" />
            <Step done={stepTodosDone} label="待办提取" />
          </ol>
          {!stepTranscriptDone && (
            <p className="mt-3 text-xs text-text-3">
              音频分片已落本地（{meeting.audio.chunk_count} 片 · {fmtClock(meeting.audio.duration_ms)}），待联网后自动转录。
            </p>
          )}
          {stepTranscriptDone && !stepSummaryDone && (
            <p className="mt-3 text-xs text-text-3">
              已转录 {transcript?.segments.length ?? 0} 段，正等待总结生成…
            </p>
          )}
        </div>
      )}

      {hasSummary ? (
        summary ? (
          <MarkdownView source={summary.content_md} />
        ) : (
          <EmptyState icon="◌" title="未找到纪要" hint="状态显示为已完成但 Summary 行缺失——尝试重新生成。" />
        )
      ) : (
        !transcript && (
          <EmptyState
            icon="◐"
            title="还没有可显示的纪要"
            hint="可在「转录」Tab 看是否有原文；或在「录音」Tab 回放原始音频。"
          />
        )
      )}
    </div>
  )
}

function Step({ done, label }: { done: boolean; label: string }): JSX.Element {
  return (
    <li className="flex items-center gap-2">
      <span
        className={`h-5 w-5 rounded-full flex items-center justify-center text-[11px] ${
          done ? 'bg-accent text-accent-contrast' : 'bg-bg-overlay text-text-3 border border-line'
        }`}
      >
        {done ? '✓' : '⋯'}
      </span>
      <span className={done ? 'text-text-1' : 'text-text-3'}>{label}</span>
    </li>
  )
}

// ── 待办 Tab ──────────────────────────────────────────────────────
function TodosTab({
  todos, onConfirm, onDelete, onConfirmAll, onJumpToTranscript,
}: {
  todos: Todo[]
  onConfirm: (t: Todo) => void | Promise<void>
  onDelete: (t: Todo) => void | Promise<void>
  onConfirmAll: () => void | Promise<void>
  onJumpToTranscript?: (t: Todo) => void
}): JSX.Element {
  return (
    <div>
      <div className="flex items-center mb-3">
        <div className="section-title">待审待办 · {todos.length}</div>
        <button onClick={() => void onConfirmAll()} className="btn-primary text-xs h-7 ml-auto">
          全部确认加入待办
        </button>
      </div>

      <div className="card p-4">
        {todos.length === 0 ? (
          <EmptyState icon="✓" title="全部已确认" hint="这些待办都已进入待办系统。" />
        ) : (
          <div className="divide-y divide-line">
            {todos.map((t) => (
              <TodoRow
                key={t.id}
                todo={t}
                onConfirm={onConfirm}
                onDelete={onDelete}
                onJumpToTranscript={onJumpToTranscript}
                showMeetingLink={false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 转录 Tab ──────────────────────────────────────────────────────
function TranscriptTab({
  transcriptId, highlightStartMs,
}: {
  transcriptId: string
  highlightStartMs: number | null
}): JSX.Element {
  const transcript = useLiveQuery(
    () => db.transcripts.where('meeting_id').equals(transcriptId).first(),
    [transcriptId],
  )
  if (!transcript) {
    return <EmptyState icon="◌" title="转录尚未完成" hint="录音结束、联网后会自动转录。" />
  }
  if (transcript.segments.length === 0) {
    return <EmptyState icon="◌" title="转录为空" hint="没有识别到语音——可能音频太短或麦克风静音。" />
  }

  // 高亮定位：找到最接近 highlightStartMs 的 segment
  const targetIndex = highlightStartMs == null
    ? -1
    : transcript.segments.reduce(
        (best, seg, i, arr) =>
          Math.abs(seg.start_ms - highlightStartMs) < Math.abs(arr[best].start_ms - highlightStartMs)
            ? i
            : best,
        0,
      )

  // 滚动到目标
  useEffect(() => {
    if (targetIndex < 0) return
    const el = document.getElementById(`seg-${transcriptId}-${targetIndex}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [targetIndex, transcriptId])

  return (
    <div className="card p-5 space-y-3">
      {transcript.segments.map((seg, i) => {
        const label = transcript.speaker_names[seg.speaker_label] ?? seg.speaker_label
        const isHighlight = i === targetIndex
        return (
          <div
            id={`seg-${transcriptId}-${i}`}
            key={i}
            className={`flex items-baseline gap-3 rounded-md transition-colors duration-200 ${
              isHighlight ? 'bg-accent/15 ring-1 ring-accent/40 px-2 -mx-2' : ''
            }`}
          >
            <span className="font-mono tabular-nums text-[11px] text-text-3 w-16 shrink-0">
              {fmtClock(seg.start_ms)}
            </span>
            <span className="chip shrink-0">{label}</span>
            <span className="text-sm text-text-1 leading-relaxed flex-1 min-w-0">{seg.text}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── 录音 Tab ──────────────────────────────────────────────────────
function AudioTab({ meetingId }: { meetingId: string }): JSX.Element {
  const chunks = useLiveQuery(
    () => db.audioChunks.where('meeting_id').equals(meetingId).sortBy('seq'),
    [meetingId],
  ) ?? []

  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (chunks.length === 0) {
      setAudioUrl(null)
      return
    }
    let url: string | null = null
    try {
      const blob = new Blob(chunks.map((c) => c.blob), { type: chunks[0].blob.type || 'audio/webm' })
      url = URL.createObjectURL(blob)
      setAudioUrl(url)
      setErr(null)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
    }
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [chunks])

  if (chunks.length === 0) {
    return <EmptyState icon="◌" title="没有可播放的录音" hint="该会议没有保留音频分片（可能为日历预占会议）。" />
  }

  return (
    <div className="card p-5 space-y-3">
      <div className="section-title">录音回放</div>
      <div className="text-xs text-text-3">
        {chunks.length} 片 · 总时长 {fmtClock(chunks.reduce((a, c) => a + c.duration_ms, 0))}
      </div>
      {audioUrl ? (
        <audio controls src={audioUrl} className="w-full mt-2" preload="metadata" />
      ) : (
        <div className="text-xs text-text-3">{err ?? '生成 blob URL 失败'}</div>
      )}
    </div>
  )
}