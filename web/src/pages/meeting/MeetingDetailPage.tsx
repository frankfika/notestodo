import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { fmtClock, fmtDateTime, mod, now, uid } from '../../lib/id'
import type { ChatMessage, Meeting, MeetingStatus, SummaryTemplate, Todo } from '../../types'
import MarkdownView from '../../components/MarkdownView'
import EmptyState from '../../components/EmptyState'
import TodoRow from '../../components/TodoRow'
import { runSummarizePipeline } from '../../pipeline/summarize'
import { callLLM } from '../../llm/client'
import { getSettings } from '../../db/settings'
import { chunksInOrder } from '../../audio/merge'

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
          hint={`回到会议列表选择一条，或按 ${mod()}⇧R 新建一场。`}
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

  const chatMessages = useLiveQuery(
    () => db.chatMessages.where('meeting_id').equals(meeting.id).sortBy('created_at'),
    [meeting.id],
  ) ?? []

  const [tab, setTab] = useState<Tab>('summary')
  const [highlightStartMs, setHighlightStartMs] = useState<number | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [seekRequest, setSeekRequest] = useState<number | null>(null)
  const [playheadMs, setPlayheadMs] = useState<number | null>(null)

  const seekToSegment = (ms: number): void => {
    setSeekRequest(ms)
    setTab('audio')
  }

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
    // 删除已有 summary — 否则 runSummarizePipeline 的「idempotent: 已有 summary 直接 return」
    // 会让「重生成」按钮完全无效。
    await db.summaries.where('meeting_id').equals(meeting.id).delete()
    // meeting 状态重置（与初次生成一致路径）
    await db.meetings.update(meeting.id, { status: 'summarizing', error: undefined, updated_at: now() })
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
    // 之前漏了 chatMessages — 累积多了会浪费磁盘 + 让关联查询变慢
    await db.chatMessages.where('meeting_id').equals(meeting.id).delete()
    if (meeting.note_id) await db.notes.delete(meeting.note_id)
    useUI.getState().goMeetings()
  }

  return (
    <div className="h-full overflow-hidden flex">
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className={`mx-auto px-6 py-8 ${chatOpen ? 'max-w-[640px]' : 'max-w-[760px]'}`}>
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
            onClick={() => setChatOpen((v) => !v)}
            className={`btn-outline text-xs h-8 ${chatOpen ? 'text-accent border-accent/40' : ''}`}
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
          <TranscriptTab
            transcriptId={meeting.id}
            highlightStartMs={highlightStartMs}
            playheadMs={playheadMs}
            onSeekTo={seekToSegment}
          />
        )}
        {tab === 'audio' && (
          <AudioTab
            meetingId={meeting.id}
            seekRequest={seekRequest}
            onPlayheadUpdate={setPlayheadMs}
          />
        )}
        </div>
      </div>
      {chatOpen && (
        <ChatPanel
          meeting={meeting}
          transcript={transcript}
          summary={summary}
          messages={chatMessages}
          onClose={() => setChatOpen(false)}
        />
      )}
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
  transcriptId, highlightStartMs, playheadMs, onSeekTo,
}: {
  transcriptId: string
  highlightStartMs: number | null
  playheadMs: number | null
  onSeekTo: (ms: number) => void
}): JSX.Element {
  const transcript = useLiveQuery(
    () => db.transcripts.where('meeting_id').equals(transcriptId).first(),
    [transcriptId],
  )

  // 高亮定位：找到最接近 highlightStartMs 的 segment
  const targetIndex = transcript && highlightStartMs != null
    ? transcript.segments.reduce(
        (best, seg, i, arr) =>
          Math.abs(seg.start_ms - highlightStartMs) < Math.abs(arr[best].start_ms - highlightStartMs)
            ? i
            : best,
        0,
      )
    : -1

  // 滚动到目标（hooks 必须无条件调用以避免 React hook order 错位）
  useEffect(() => {
    if (targetIndex < 0) return
    const el = document.getElementById(`seg-${transcriptId}-${targetIndex}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [targetIndex, transcriptId])

  // 当前播放高亮：playheadMs 落在哪一段
  const activeIndex = playheadMs != null && transcript
    ? transcript.segments.findIndex(
        (seg, i) => seg.start_ms <= playheadMs &&
          (i === transcript.segments.length - 1 || transcript.segments[i + 1].start_ms > playheadMs),
      )
    : -1

  if (!transcript) {
    return <EmptyState icon="◌" title="转录尚未完成" hint="录音结束、联网后会自动转录。" />
  }
  if (transcript.segments.length === 0) {
    return <EmptyState icon="◌" title="转录为空" hint="没有识别到语音——可能音频太短或麦克风静音。" />
  }

  return (
    <div className="card p-5 space-y-3">
      {transcript.segments.map((seg, i) => {
        const label = transcript.speaker_names[seg.speaker_label] ?? seg.speaker_label
        const isHighlight = i === targetIndex
        const isActive = i === activeIndex
        return (
          <div
            id={`seg-${transcriptId}-${i}`}
            key={i}
            className={`group flex items-baseline gap-3 rounded-md transition-colors duration-200 ${
              isActive ? 'bg-accent/12 ring-1 ring-accent/30 px-2 -mx-2'
              : isHighlight ? 'bg-accent/15 ring-1 ring-accent/40 px-2 -mx-2'
              : ''
            }`}
          >
            <button
              type="button"
              onClick={() => onSeekTo(seg.start_ms)}
              className="font-mono tabular-nums text-[11px] text-text-3 hover:text-accent w-16 shrink-0 text-left transition-colors"
              title={`跳到 ${fmtClock(seg.start_ms)} 播放`}
            >{fmtClock(seg.start_ms)}</button>
            <span className="chip shrink-0">{label}</span>
            <span className="text-sm text-text-1 leading-relaxed flex-1 min-w-0">{seg.text}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── 录音 Tab ──────────────────────────────────────────────────────
function AudioTab({
  meetingId, seekRequest, onPlayheadUpdate,
}: {
  meetingId: string
  seekRequest: number | null
  onPlayheadUpdate: (ms: number | null) => void
}): JSX.Element {
  const chunks = useLiveQuery(
    () => db.audioChunks.where('meeting_id').equals(meetingId).toArray(),
    [meetingId],
  ) ?? []

  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    if (chunks.length === 0) {
      setAudioUrl(null)
      return
    }
    let url: string | null = null
    try {
      // 与 mergeAudioChunks 共享同一排序规则 — 用户播放听到的就是转录用的音频
      const ordered = chunksInOrder(chunks).filter((c) => c.blob && c.blob.size > 0)
      if (ordered.length === 0) {
        setAudioUrl(null)
        setErr('该会议只有占位分片（空数据）')
        return
      }
      const blob = new Blob(ordered.map((c) => c.blob), { type: ordered[0].blob.type || 'audio/webm' })
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

  // 处理来自转录的 seek 请求：跳转到指定毫秒并自动播放
  useEffect(() => {
    if (seekRequest == null) return
    const el = audioRef.current
    if (!el) return
    el.currentTime = seekRequest / 1000
    void el.play().catch(() => { /* user gesture needed */ })
  }, [seekRequest])

  if (chunks.length === 0) {
    return <EmptyState icon="◌" title="没有可播放的录音" hint="该会议没有保留音频分片（可能为日历预占会议）。" />
  }

  return (
    <div className="card p-5 space-y-3">
      <div className="section-title">录音回放</div>
      <div className="text-xs text-text-3">
        {chunks.length} 片 · 总时长 {fmtClock(chunks.reduce((a, c) => a + c.duration_ms, 0))}
        {seekRequest != null && (
          <span className="ml-2 text-accent">· 跳到 {fmtClock(seekRequest)}</span>
        )}
      </div>
      {audioUrl ? (
        <audio
          ref={audioRef}
          controls
          src={audioUrl}
          className="w-full mt-2"
          preload="metadata"
          onTimeUpdate={(e) => {
            const t = (e.target as HTMLAudioElement).currentTime
            onPlayheadUpdate(Math.round(t * 1000))
          }}
          onPause={() => onPlayheadUpdate(null)}
          onEnded={() => onPlayheadUpdate(null)}
        />
      ) : (
        <div className="text-xs text-text-3">{err ?? '生成 blob URL 失败'}</div>
      )}
    </div>
  )
}

// ── AI 对话面板 ─────────────────────────────────────────────
function ChatPanel({
  meeting, transcript, summary, messages, onClose,
}: {
  meeting: Meeting
  transcript: { segments: { speaker_label: string; text: string; start_ms: number; end_ms: number }[] } | undefined
  summary: { content_md: string } | undefined
  messages: ChatMessage[]
  onClose: () => void
}): JSX.Element {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length])

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setErr(null)
    setBusy(true)

    const userMsg: ChatMessage = {
      id: uid(),
      meeting_id: meeting.id,
      role: 'user',
      content: text,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
      sync_version: 0,
    }
    await db.chatMessages.add(userMsg)

    try {
      const settings = await getSettings()
      if (!settings.llm_api_key) {
        throw new Error('请先在「设置」页填 LLM API Key')
      }
      const transcriptText = transcript?.segments
        .map((s) => `[${fmtClock(s.start_ms)}] ${s.speaker_label}: ${s.text}`)
        .join('\n') ?? '(无转录)'
      const summaryText = summary?.content_md ?? '(暂无纪要)'

      // 长转录成本/延迟保护：超过 12K 字符截断并附标记，LLM 上下文不被压垮
      const TRANSCRIPT_LIMIT = 12_000
      let transcriptBlock = transcriptText
      if (transcriptText.length > TRANSCRIPT_LIMIT) {
        const head = transcriptText.slice(0, TRANSCRIPT_LIMIT)
        const dropped = transcriptText.length - TRANSCRIPT_LIMIT
        transcriptBlock = `${head}\n\n[…以下 ${dropped} 字符被省略，原转录 ${transcript?.segments.length ?? 0} 段；如需查阅请回到会议详情。]`
      }

      const system = `你是本次会议的 AI 助手。会议信息：
- 标题：${meeting.title}
- 时间：${meeting.started_at}
- 时长：${fmtClock(meeting.audio.duration_ms)}

## 转录全文（按时间排序，时间戳为 MM:SS）
${transcriptBlock}

## AI 纪要
${summaryText}

请只基于上述上下文回答；引用转录时给出形如 [MM:SS] 的时间戳；不知道就说不知道。`

      const llmInput: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [{ role: 'system', content: system }]
      for (const m of messages) llmInput.push({ role: m.role, content: m.content })
      llmInput.push({ role: 'user', content: text })

      const reply = await callLLM(settings, llmInput, { maxTokens: 1024, temperature: 0.3 })

      const aiMsg: ChatMessage = {
        id: uid(),
        meeting_id: meeting.id,
        role: 'assistant',
        content: reply,
        created_at: now(),
        updated_at: now(),
        deleted_at: null,
        sync_version: 0,
      }
      await db.chatMessages.add(aiMsg)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="
      fixed md:static inset-0 md:inset-auto z-40 md:z-auto
      w-full md:w-[420px] shrink-0 border-l border-line bg-bg-raise flex flex-col
    ">
      <div className="flex items-center gap-2 px-4 h-12 border-b border-line">
        <span className="text-text-2 text-sm">对话</span>
        <span className="chip">{messages.length}</span>
        <button onClick={onClose} className="icon-btn ml-auto" title="关闭" aria-label="关闭">✕</button>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-text-3 text-sm py-8">
            对这场会议提问。<br />
            <span className="text-[11px]">上下文：纪要 + 全文转录</span>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words ${
                m.role === 'user'
                  ? 'bg-accent text-accent-contrast rounded-br-md'
                  : 'bg-bg-overlay text-text-1 rounded-bl-md border border-line'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="bg-bg-overlay border border-line rounded-2xl rounded-bl-md px-3.5 py-2 text-[13px] text-text-3">
              <span className="rec-dot">●</span> 思考中…
            </div>
          </div>
        )}
        {err && <div className="text-xs text-danger text-center">{err}</div>}
      </div>
      <div className="border-t border-line p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
          className="input text-sm"
          placeholder="提问这场会议…（Enter 发送，Shift+Enter 换行）"
          disabled={busy}
        />
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[11px] text-text-3">上下文：纪要 + 全文转录</span>
          <button
            onClick={() => void send()}
            disabled={busy || !input.trim()}
            className="btn-primary text-xs h-7 ml-auto"
          >发送</button>
        </div>
      </div>
    </aside>
  )
}