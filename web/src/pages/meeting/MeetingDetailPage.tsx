import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { fmtClock, fmtDateTime, mod, now, uid } from '../../lib/id'
import type { ChatMessage, Meeting, MeetingStatus, SummaryTemplate, Todo } from '../../types'
import MarkdownView from '../../components/MarkdownView'
import EmptyState from '../../components/EmptyState'
import TodoRow from '../../components/TodoRow'
import OverflowMenu from '../../components/OverflowMenu'
import { runSummarizePipeline } from '../../pipeline/summarize'
import { callLLM } from '../../llm/client'
import { getSettings } from '../../db/settings'
import { runTranscribePipeline } from '../../pipeline/transcribe'
import LevelMeter from '../../components/LevelMeter'
import { chunksInOrder } from '../../audio/merge'
import { levelLabel, suggestKr } from '../../lib/okr'
import { useRecorder } from '../../state/recorder'
import {
  listPinnedCards,
  pinAssistCard,
  retrieveKnowledge,
  unpinAssistCard,
} from '../../lib/knowledge'
import type { KnowledgeEntry, PinnedAssistCard } from '../../types'

type Tab = 'notes' | 'scribble' | 'transcript' | 'assist'

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
    case 'recording': return 'border-danger/30 text-danger bg-danger/8'
    case 'processing':
    case 'transcribed':
    case 'summarizing': return 'border-warning/40 text-warning bg-warning/8'
    case 'summarized': return 'border-accent/40 text-accent bg-accent/8'
    case 'failed': return 'border-danger/40 text-danger bg-danger/8'
  }
}

/**
 * 会议详情：标题 + 状态 + Tab(速记/笔记/纪要/待办/转录/录音)
 * - 录音中：速记（Scribble）是主角，其它 Tab 让路
 * - 整理（Polish）：速记 + 转录 → 润色笔记，写入会议关联的 Note
 * - 深度总结：原模板纪要 + 待办提取管线
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
  const note = useLiveQuery(
    async () => meeting.note_id ? await db.notes.get(meeting.note_id) : undefined,
    [meeting.note_id],
  )
  const openKrs = useLiveQuery(
    () => db.todos.where('kind').equals('kr').and((k) => k.deleted_at === null && k.status === 'open').toArray(),
    [],
  ) ?? []
  const templates = useLiveQuery(
    () => db.templates.toArray(),
    [],
  ) ?? []

  const chatMessages = useLiveQuery(
    () => db.chatMessages.where('meeting_id').equals(meeting.id).sortBy('created_at'),
    [meeting.id],
  ) ?? []

  const isRecording = meeting.status === 'recording'
  const [tab, setTab] = useState<Tab>('notes')
  const [highlightStartMs, setHighlightStartMs] = useState<number | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [seekRequest, setSeekRequest] = useState<number | null>(null)
  const [playheadMs, setPlayheadMs] = useState<number | null>(null)

  const seekToSegment = (ms: number): void => {
    setSeekRequest(ms)
  }

  const jumpToTranscript = (t: Todo): void => {
    if (t.transcript_span?.start_ms != null) {
      setHighlightStartMs(t.transcript_span.start_ms)
    } else if (t.meeting_id) {
      setHighlightStartMs(0)
    }
    setTab('transcript')
  }

  const hasTranscript = Boolean(transcript && transcript.segments.length > 0)
  const hasNote = Boolean(summary) || Boolean(note?.body_md)
  const inFlight = meeting.status === 'processing' || meeting.status === 'transcribed' || meeting.status === 'summarizing'

  // 会议待办 → OKR：默认进 Inbox；只有用户点了建议才挂到 KR（不自动深挂）
  async function confirmTodo(t: Todo, kr?: Todo): Promise<void> {
    await db.todos.update(t.id, {
      status: 'open',
      parent_id: kr?.id ?? null,
      scope: kr?.scope ?? null,
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

  /** 失败后重试：转录已存在则直接续跑总结（管线幂等）。 */
  async function retry(): Promise<void> {
    await db.meetings.update(meeting.id, { status: 'processing', error: undefined, updated_at: now() })
    await runTranscribePipeline(meeting.id).catch((e) => console.error('重试失败', e))
  }

  /** 用最新速记 + 默认模板重新整理笔记。 */
  async function regenerate(): Promise<void> {
    const t = templates.find((x) => x.is_default && !x.deleted_at) ?? templates.find((x) => !x.deleted_at)
    if (t) await rerunWith(t.id)
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

  if (isRecording) return <LiveView meeting={meeting} />

  return (
    <div className="h-full overflow-hidden flex">
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className={`mx-auto px-6 py-8 ${chatOpen ? 'max-w-[640px]' : 'max-w-[760px]'}`}>
        {/* 顶部：标题 + 一个次要操作区 */}
        <div className="flex items-start gap-3 mb-5">
          <button
            onClick={useUI.getState().goMeetings}
            className="icon-btn -ml-2 mt-0.5"
            title="返回列表"
            aria-label="返回"
          >←</button>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold text-text-1 truncate">{meeting.title}</h1>
            <div className="flex items-center gap-2 text-xs text-text-3 mt-1">
              <span>{fmtDateTime(meeting.started_at)}</span>
              <span>·</span>
              <span className="tabular-nums">{fmtClock(meeting.audio.duration_ms)}</span>
            </div>
          </div>
          <button
            onClick={() => setChatOpen((v) => !v)}
            className={`btn-ghost text-xs h-8 px-3 ${chatOpen ? 'text-accent' : ''}`}
          >对话</button>
          <OverflowMenu items={[
            { label: '按最新速记重新整理', onClick: () => void regenerate() },
            ...templates.filter((t) => !t.deleted_at).map((t) => ({ label: `用「${t.name}」重新生成`, onClick: () => void rerunWith(t.id) })),
            { label: '删除会议', danger: true, onClick: () => void deleteMeeting() },
          ]} />
        </div>

        {/* Tab：笔记（含待办）· 速记 · 转录（含录音）· 助手 */}
        <div className="border-b border-line flex items-center gap-1 mb-6 text-sm">
          <TabBtn active={tab === 'notes'} onClick={() => setTab('notes')}>
            笔记{reviewTodos.length > 0 && <span className="ml-1 text-[11px] text-accent">· {reviewTodos.length} 待办</span>}
          </TabBtn>
          <TabBtn active={tab === 'scribble'} onClick={() => setTab('scribble')}>速记</TabBtn>
          <TabBtn active={tab === 'transcript'} onClick={() => setTab('transcript')}>转录 · 录音</TabBtn>
          <TabBtn active={tab === 'assist'} onClick={() => setTab('assist')}>助手</TabBtn>
        </div>

        {tab === 'notes' && (
          <div className="space-y-8">
            {inFlight && !hasNote && <Progress meeting={meeting} hasTranscript={hasTranscript} />}
            {meeting.status === 'failed' && (
              <div className="card p-4 border-danger/30 bg-danger/5 flex items-center gap-3">
                <span className="text-sm text-text-1 flex-1 min-w-0">{meeting.error ?? '处理失败'}</span>
                <button onClick={() => void retry()} className="btn-primary text-xs h-8 px-3 shrink-0">重试</button>
              </div>
            )}
            {note?.body_md ? (
              <MarkdownView source={note.body_md} />
            ) : (
              !inFlight && meeting.status !== 'failed' && (
                <EmptyState
                  title="还没有笔记"
                  hint="录音结束后会自动转录并整理成笔记。"
                  action={hasTranscript ? <button onClick={() => void regenerate()} className="btn-primary h-8 text-xs px-3">现在整理</button> : undefined}
                />
              )
            )}
            {reviewTodos.length > 0 && (
              <TodosTab
                todos={reviewTodos}
                onConfirm={confirmTodo}
                onDelete={deleteTodo}
                onConfirmAll={confirmAll}
                onJumpToTranscript={jumpToTranscript}
                krs={openKrs}
              />
            )}
          </div>
        )}
        {tab === 'scribble' && (
          <ScribblePane meeting={meeting} live={false} onRegenerate={() => void regenerate()} />
        )}
        {tab === 'transcript' && (
          <div className="space-y-4">
            <AudioTab meetingId={meeting.id} seekRequest={seekRequest} onPlayheadUpdate={setPlayheadMs} />
            <TranscriptTab
              transcriptId={meeting.id}
              highlightStartMs={highlightStartMs}
              playheadMs={playheadMs}
              onSeekTo={seekToSegment}
            />
          </div>
        )}
        {tab === 'assist' && (
          <AssistPane
            meeting={meeting}
            scribbleMd={meeting.scribble_md}
            transcriptText={transcript?.segments.map((s) => s.text).join(' ')}
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

/** 录音中：整页只有速记。计时 / 电平 / 停止都在一条顶栏里。 */
function LiveView({ meeting }: { meeting: Meeting }): JSX.Element {
  const elapsed = useRecorder((s) => s.elapsedMs)
  const level = useRecorder((s) => s.audioLevel)
  const interrupted = useRecorder((s) => s.interrupted)
  const captureMode = useRecorder((s) => s.captureMode)
  const stop = useRecorder((s) => s.stop)
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-6 py-6">
        <div className="flex items-center gap-3 mb-4">
          <span className={`rec-dot h-2.5 w-2.5 rounded-full ${interrupted ? 'bg-warning' : 'bg-danger'}`} />
          <span className="font-mono tabular-nums text-2xl text-text-1">{fmtClock(elapsed)}</span>
          <LevelMeter level={level} />
          <span className="text-xs text-text-3 truncate">
            {interrupted ? '麦克风被中断，正在恢复…' : `正在录音 · ${captureMode === 'mic+system' ? '麦克风 + 系统声音' : '仅麦克风'}`}
          </span>
          <button onClick={() => void stop()} className="ml-auto btn-danger h-9 px-4">■ 停止</button>
        </div>
        <ScribblePane meeting={meeting} live />
        <p className="mt-3 text-xs text-text-3">结束后自动转录并整理成笔记 + 待办，不需要再点任何按钮。</p>
      </div>
    </div>
  )
}

/** 会后处理进度：一行讲清楚走到哪一步。 */
function Progress({ meeting, hasTranscript }: { meeting: Meeting; hasTranscript: boolean }): JSX.Element {
  const label = hasTranscript || meeting.status === 'summarizing' ? '正在整理笔记与待办…' : '正在转录录音…'
  return (
    <div className="card p-5 flex items-center gap-3">
      <span className="rec-dot h-2 w-2 rounded-full bg-accent" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-1">{label}</div>
        <div className="text-xs text-text-3 mt-0.5">可以离开此页，完成后在「会议」里找到它。</div>
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

// ── 速记 Scribble ─────────────────────────────────────────────────
// 会中只记 2–3 字的 bullet；本地防抖保存到 meeting.scribble_md。
function ScribblePane({
  meeting, live, onRegenerate,
}: {
  meeting: Meeting
  live: boolean
  onRegenerate?: () => void
}): JSX.Element {
  const [text, setText] = useState(meeting.scribble_md ?? '')
  const [saved, setSaved] = useState(true)
  const pending = useRef<string | null>(null)

  const flush = (): void => {
    if (pending.current === null) return
    const v = pending.current
    pending.current = null
    void db.meetings.update(meeting.id, { scribble_md: v, updated_at: now() }).then(() => setSaved(true))
  }
  useEffect(() => {
    if (pending.current === null) return
    const id = setTimeout(flush, 400)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])
  // 切 Tab / 离开页面时立刻落库
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => flush, [])

  function onChange(v: string): void {
    pending.current = v
    setSaved(false)
    setText(v)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // 回车自动续写 bullet
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    const el = e.currentTarget
    const before = text.slice(0, el.selectionStart)
    const line = before.slice(before.lastIndexOf('\n') + 1)
    if (!/^\s*- /.test(line)) return
    e.preventDefault()
    if (line.trim() === '-') {
      // 空 bullet 再回车 → 结束列表
      const start = before.length - line.length
      onChange(text.slice(0, start) + text.slice(el.selectionStart))
      return
    }
    const insert = '\n' + line.match(/^\s*- /)![0]
    const next = before + insert + text.slice(el.selectionEnd)
    onChange(next)
    const pos = before.length + insert.length
    requestAnimationFrame(() => el.setSelectionRange(pos, pos))
  }

  return (
    <div className={`rounded-xl border bg-bg-raise ${live ? 'border-danger/25 shadow-[0_0_0_4px_color-mix(in_oklch,var(--danger)_6%,transparent)]' : 'border-line'}`}>
      <div className="flex items-center gap-2 px-4 h-10 border-b border-line text-xs text-text-3">
        <span className="font-medium text-text-2">速记</span>
        <span>{live ? '只记关键词，结束后 AI 用转录补全成完整笔记' : '会中的速记 · 改完可重新整理'}</span>
        <span className="ml-auto">{saved ? '已保存' : '保存中…'}</span>
      </div>
      <textarea
        autoFocus={live}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={flush}
        placeholder={'- q4 预算??\n- 上线时间风险\n- @法务 合同'}
        className={`w-full resize-none bg-transparent px-4 py-3 outline-none text-[15px] leading-7 text-text-1 placeholder:text-text-disabled font-mono ${live ? 'min-h-[52vh]' : 'min-h-[240px]'}`}
      />
      {!live && onRegenerate && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-t border-line">
          <span className="text-[11px] text-text-3">速记为骨架 + 转录补全细节</span>
          <button onClick={onRegenerate} className="btn-outline text-xs h-7 px-3 ml-auto">按此重新整理</button>
        </div>
      )}
    </div>
  )
}

// ── 待办 Tab ──────────────────────────────────────────────────────
function TodosTab({
  todos, onConfirm, onDelete, onConfirmAll, onJumpToTranscript, krs,
}: {
  todos: Todo[]
  krs: Todo[]
  onConfirm: (t: Todo, kr?: Todo) => void | Promise<void>
  onDelete: (t: Todo) => void | Promise<void>
  onConfirmAll: () => void | Promise<void>
  onJumpToTranscript?: (t: Todo) => void
}): JSX.Element {
  return (
    <div>
      <div className="flex items-center mb-3">
        <div className="section-title">AI 提取的待办 · {todos.length}</div>
        <button onClick={() => void onConfirmAll()} className="btn-primary text-xs h-7 ml-auto">
          全部加入待办
        </button>
      </div>

      <div className="card p-4">
        {todos.length === 0 ? (
          <EmptyState title="全部已确认" hint="这些待办都已进入 OKR / Inbox。" />
        ) : (
          <div className="divide-y divide-line">
            {todos.map((t) => {
              const kr = suggestKr(t.title, krs)
              return (
                <div key={t.id}>
                  <TodoRow
                    todo={t}
                    onConfirm={(x) => onConfirm(x)}
                    onDelete={onDelete}
                    onJumpToTranscript={onJumpToTranscript}
                    showMeetingLink={false}
                  />
                  {kr && (
                    <button
                      onClick={() => void onConfirm(t, kr)}
                      className="ml-12 mb-2 -mt-0.5 text-[11.5px] text-text-3 hover:text-accent transition-colors"
                      title="确认并挂到这个 KR（✓ 则进 Inbox）"
                    >确认并挂到 {levelLabel(kr)} · <span className="text-text-2">{kr.title}</span></button>
                  )}
                </div>
              )
            })}
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

// ── Live Assist（Phase-2 item 5）──────────────────────────────────────────
// 录制中（或刚结束）：从速记 + 最近转录片段拼成 query → keyword 检索
// KnowledgeEntries；Pinned 卡片持久化在会议下，跨 retrieve 持续显示。
function AssistPane({
  meeting, scribbleMd, transcriptText,
}: {
  meeting: Meeting
  scribbleMd: string | undefined
  transcriptText: string | undefined
}): JSX.Element {
  const entries = useLiveQuery(() => db.knowledgeEntries.toArray(), []) ?? []
  const settings = useLiveQuery(async () => {
    const row = await db.kv.get('settings')
    return ((row?.value as { knowledge_folders?: string[] } | undefined)?.knowledge_folders) ?? []
  }, []) ?? []

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KnowledgeEntry[]>([])
  const [pinned, setPinned] = useState<PinnedAssistCard[]>([])

  // 计算 query：用户输入 > 速记 > 转录尾部 200 字
  const effectiveQuery = useMemo(() => {
    if (query.trim()) return query.trim()
    if (scribbleMd && scribbleMd.trim()) return scribbleMd.trim().slice(0, 400)
    if (transcriptText) {
      const tail = transcriptText.slice(-200)
      return tail
    }
    return ''
  }, [query, scribbleMd, transcriptText])

  // debounce 200ms 自动重新检索
  useEffect(() => {
    if (!effectiveQuery) {
      setHits([])
      return
    }
    const t = setTimeout(() => {
      setHits(retrieveKnowledge(effectiveQuery, entries, 8))
    }, 200)
    return () => clearTimeout(t)
  }, [effectiveQuery, entries])

  // 加载 pinned
  const refreshPinned = useCallback(async (): Promise<void> => {
    setPinned(await listPinnedCards(meeting.id))
  }, [meeting.id])
  useEffect(() => {
    void refreshPinned()
  }, [refreshPinned])

  async function togglePin(entry: KnowledgeEntry): Promise<void> {
    const existing = pinned.find((p) => p.source_entry_id === entry.id)
    if (existing) {
      await unpinAssistCard(existing.id)
    } else {
      await pinAssistCard(meeting.id, entry)
    }
    await refreshPinned()
  }

  if (settings.length === 0) {
    return (
      <EmptyState
        icon="◇"
        title="还没有知识库文件夹"
        hint="在「设置 → 知识库」里添加 .md / .txt 路径，重新索引后这里会按速记 / 转录推荐相关卡片。"
        action={
          <button
            onClick={() => useUI.getState().goSettings()}
            className="btn-outline text-xs h-8 px-3"
          >→ 设置</button>
        }
      />
    )
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        icon="◇"
        title="还没有索引过的内容"
        hint={`已配置 ${settings.length} 个文件夹，但还没有可检索的条目。先在「设置 → 知识库」点「重新索引」。`}
        action={
          <button
            onClick={() => useUI.getState().goSettings()}
            className="btn-outline text-xs h-8 px-3"
          >→ 去索引</button>
        }
      />
    )
  }

  return (
    <div>
      <div className="card p-4 mb-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="section-title">检索</span>
          <span className="text-[11px] text-text-3">
            来自速记 / 转录 / 手动输入 — 关键词 + 标题匹配
          </span>
        </div>
        <input
          className="input"
          placeholder="想找什么？或留空用速记自动检索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!query.trim() && effectiveQuery && (
          <div className="mt-2 text-[11px] text-text-3 truncate" title={effectiveQuery}>
            自动 query：{effectiveQuery.slice(0, 80)}{effectiveQuery.length > 80 ? '…' : ''}
          </div>
        )}
      </div>

      {pinned.length > 0 && (
        <div className="mb-4">
          <div className="section-title mb-2">已固定 · {pinned.length}</div>
          <div className="space-y-2">
            {pinned.map((p) => (
              <PinnedCardRow key={p.id} card={p} onUnpin={() => void togglePin({
                id: p.source_entry_id ?? p.id,
                folder: '', path: p.path, title: p.title, snippet: p.snippet,
                fullText: '', mtime: 0, size_bytes: 0,
                created_at: p.created_at, updated_at: p.updated_at, deleted_at: null, sync_version: 0,
              })} />
            ))}
          </div>
        </div>
      )}

      <div className="section-title mb-2">相关 · {hits.length}</div>
      {hits.length === 0 ? (
        <div className="text-[12px] text-text-3 py-6 text-center">
          没有匹配 — 换个关键词或去「设置」添加更多文件夹。
        </div>
      ) : (
        <div className="space-y-2">
          {hits.map((e) => {
            const isPinned = pinned.some((p) => p.source_entry_id === e.id)
            return (
              <div key={e.id} className="card p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-1 truncate">{e.title}</div>
                    <div className="text-[11px] text-text-3 font-mono truncate mt-0.5" title={e.path}>
                      {e.folder} / {e.path}
                    </div>
                    <div className="text-[12px] text-text-2 mt-1.5 line-clamp-3 leading-relaxed">
                      {e.snippet}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void togglePin(e)}
                    className={isPinned ? 'btn-primary text-[11px] h-7 px-2.5' : 'btn-outline text-[11px] h-7 px-2.5'}
                    title={isPinned ? '取消固定' : '固定到这场会议'}
                  >
                    {isPinned ? '✓ 已固定' : '固定'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PinnedCardRow({
  card, onUnpin,
}: {
  card: PinnedAssistCard
  onUnpin: () => void | Promise<void>
}): JSX.Element {
  return (
    <div className="card p-3 border-accent/30 bg-accent/5">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-1 truncate">{card.title}</div>
          <div className="text-[11px] text-text-3 font-mono truncate mt-0.5">{card.path}</div>
          <div className="text-[12px] text-text-2 mt-1.5 line-clamp-3 leading-relaxed">
            {card.snippet}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onUnpin()}
          className="btn-outline text-[11px] h-7 px-2.5"
          title="取消固定"
        >✕ 取消</button>
      </div>
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
    // 先 clear input，让用户感觉「已发出」；如果 LLM 失败，再恢复（让用户可以重试）
    setInput('')
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
      // LLM 失败：把 user 输入恢复回 textarea（user 已 add 到 DB，但 UI 不该让用户重打）
      setInput(text)
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