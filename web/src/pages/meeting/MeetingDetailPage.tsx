import { resolveLLMConfig } from '../../types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { fmtClock, fmtDateTime, mod, now, uid } from '../../lib/id'
import type { ChatMessage, Meeting, MeetingStatus, Scribble, SummaryTemplate, Todo } from '../../types'
import MarkdownView from '../../components/MarkdownView'
import EmptyState from '../../components/EmptyState'
import OverflowMenu from '../../components/OverflowMenu'
import { runSummarizePipeline } from '../../pipeline/summarize'
import { callLLM } from '../../llm/client'
import { getSettings } from '../../db/settings'
import { chunksInOrder } from '../../audio/merge'
import { scribblesToMarkdown } from '../../llm/prompts'
import { levelLabel, suggestKr } from '../../lib/okr'
import { attachTask, discardTask } from '../../lib/todoActions'
import { MODEL_MISSING } from '../../llm/builtin'
import { displayStatus, statusText, type DisplayStatus } from '../../lib/meetingStatus'
import { useMissingBuiltin, missingNames } from '../../components/BuiltinModels'
import { useSettings } from '../../db/settings'
import { useRecorder } from '../../state/recorder'
import { setLiveCaptionEnabled, useCaption } from '../../lib/liveCaption'
import {
  listPinnedCards,
  pinAssistCard,
  retrieveKnowledge,
  unpinAssistCard,
} from '../../lib/knowledge'
import type { KnowledgeEntry, PinnedAssistCard } from '../../types'

// Foresight 式：一场会一份笔记。速记 / 待办确认并入「笔记」，录音并入「转录」
type Tab = 'notes' | 'transcript' | 'assist'

function statusTone(s: DisplayStatus): string {
  switch (s) {
    case 'waiting_model': return 'border-warning/40 text-warning bg-warning/8'
    case 'recording': return 'border-danger/30 text-danger bg-danger/8'
    case 'processing':
    case 'transcribed':
    case 'summarizing': return 'border-warning/40 text-warning bg-warning/8'
    case 'summarized': return 'border-accent/40 text-accent bg-accent/8'
    case 'failed': return 'border-danger/40 text-danger bg-danger/8'
  }
}

/**
 * 会议详情：标题 + 状态 + Tab(笔记/转录/资料)
 * - 录音中：全屏速记（LiveMeetingView）
 * - 散会后一次 AI 调用（pipeline/summarize）：速记 + 转录 → 标题 + 笔记 + 待办
 *   笔记 Tab 顶部是待确认待办，中间 AI 笔记，底部原始速记
 * - 重新整理 / 换模板：同一条管线重跑
 * - 转录 Tab 顶部是录音播放器，点时间戳跳播
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

  const scribbles = useLiveQuery(
    () => db.scribbles.where('meeting_id').equals(meeting.id).sortBy('created_at'),
    [meeting.id],
  ) ?? []
  const scribbleMd = useMemo(() => scribblesToMarkdown(scribbles), [scribbles])

  const isRecording = meeting.status === 'recording'
  const [tab, setTab] = useState<Tab>('notes')
  const [polishing, setPolishing] = useState(false)
  const [highlightStartMs, setHighlightStartMs] = useState<number | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [seekRequest, setSeekRequest] = useState<number | null>(null)
  const [playheadMs, setPlayheadMs] = useState<number | null>(null)

  const seekToSegment = (ms: number): void => {
    setSeekRequest(ms)
    setTab('transcript')
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
  const inFlight = meeting.status === 'processing' || meeting.status === 'transcribed' || meeting.status === 'summarizing'

  /** 重新整理（可换模板）：同一条管线重跑；失败原因由管线写进 meeting.error */
  async function regenerate(templateId?: string): Promise<void> {
    if (polishing) return
    setPolishing(true)
    setTab('notes')
    try {
      if (templateId) await db.kv.put({ key: `meeting_template_${meeting.id}`, value: templateId })
      // 删掉旧 summary —— 否则管线「已有 summary 直接 return」，重跑无效
      await db.summaries.where('meeting_id').equals(meeting.id).delete()
      await db.meetings.update(meeting.id, { status: 'summarizing', error: undefined, updated_at: now() })
      await runSummarizePipeline(meeting.id).catch((e) => console.error('重新整理失败', e))
    } finally {
      setPolishing(false)
    }
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
    await db.scribbles.where('meeting_id').equals(meeting.id).delete()
    if (meeting.note_id) await db.notes.delete(meeting.note_id)
    useUI.getState().goMeetings()
  }

  // 会中：Foresight 式实时布局 —— 左速记 / 右（实时转录 + 相关资料）
  if (isRecording) {
    return (
      <LiveMeetingView
        meeting={meeting}
        scribbleMd={scribbleMd}
        transcriptText={transcript?.segments.map((s) => s.text).join(' ')}
      />
    )
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
            <div className="flex items-center gap-2 text-xs text-text-3 mt-1">
              <span>{fmtDateTime(meeting.started_at)}</span>
              <span>·</span>
              {isRecording ? <LiveClock meetingId={meeting.id} /> : <span className="tabular-nums">{fmtClock(meeting.audio.duration_ms)}</span>}
            </div>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-md border ${statusTone(displayStatus(meeting))}`}>
            {statusText(meeting)}
          </span>
        </div>

        {/* 操作行 */}
        <div className="flex items-center gap-2 mt-3 mb-4">
          {!isRecording && (
            <button
              onClick={() => void regenerate()}
              disabled={polishing || inFlight || !transcript}
              className="btn-primary text-xs h-8 px-3"
              title="按最新速记 + 转录重新生成笔记与待办（散会后已自动整理一次）"
            >{polishing || inFlight ? '整理中…' : note?.body_md ? '重新整理' : '整理笔记'}</button>
          )}
          {!isRecording && <RerunDropdown templates={templates} onPick={(id) => regenerate(id)} />}
          <button
            onClick={() => setChatOpen((v) => !v)}
            className={`btn-ghost text-xs h-8 px-3 ${chatOpen ? 'text-accent' : ''}`}
          >对话</button>
          <div className="ml-auto">
            <OverflowMenu items={[{ label: '删除会议', danger: true, onClick: () => void deleteMeeting() }]} />
          </div>
        </div>
        {meeting.status === 'failed' && (
          meeting.error?.includes(MODEL_MISSING) ? (
            // 不是失败：录音已安全保存，只是在等本地模型；下载完成会自动续跑
            <div className="card p-3 mb-4 border-warning/40 flex items-center gap-3 text-xs">
              <span className="text-text-2 flex-1 min-w-0">⏳ 录音已保存在本机，等本地模型下载完成后自动整理。</span>
              <button onClick={() => useUI.getState().goSettings()} className="btn-primary text-xs h-7 px-3 shrink-0">去下载模型</button>
            </div>
          ) : (
            <div className="card p-3 mb-4 border-danger/30 flex items-center gap-3 text-xs">
              <span className="text-danger flex-1 min-w-0">{meeting.error ?? '整理失败'}</span>
              {transcript && <button onClick={() => void regenerate()} className="btn-outline text-xs h-7 px-3 shrink-0">重试</button>}
            </div>
          )
        )}

        {/* Tab 栏 */}
        <div className="border-b border-line flex items-center gap-1 mb-6 text-sm">
          <TabBtn active={tab === 'notes'} onClick={() => setTab('notes')}>
            笔记{reviewTodos.length > 0 && <span className="ml-1 text-[11px] text-accent tabular-nums">· {reviewTodos.length} 待办</span>}
          </TabBtn>
          <TabBtn active={tab === 'transcript'} onClick={() => setTab('transcript')}>转录</TabBtn>
          <TabBtn active={tab === 'assist'} onClick={() => setTab('assist')}>资料</TabBtn>
        </div>

        {/* 内容 */}
        {tab === 'notes' && (
          <div className="space-y-6">
            {reviewTodos.length > 0 && (
              <PendingTodos todos={reviewTodos} krs={openKrs} onJumpToTranscript={jumpToTranscript} />
            )}
            {note?.body_md ? (
              <MarkdownView source={note.body_md} />
            ) : (
              <div className="card">
                <EmptyState
                  icon={inFlight || polishing ? '◌' : '✎'}
                  title={inFlight || polishing ? 'AI 正在整理笔记…' : '还没有整理过的笔记'}
                  hint={inFlight
                    ? `${hasTranscript ? '正在把速记 + 转录整理成笔记、提取待办' : '正在转录录音'}，完成后待办会出现在这里等你确认。可以先离开。`
                    : hasTranscript ? '点「整理笔记」：用转录把速记扩写成完整笔记。' : '录音转录完成后会自动整理。'}
                />
              </div>
            )}
            <ScribbleEditor meeting={meeting} live={false} onSeek={seekToSegment} />
          </div>
        )}
        {tab === 'transcript' && (
          <div className="space-y-4">
            <AudioTab
              meetingId={meeting.id}
              seekRequest={seekRequest}
              onPlayheadUpdate={setPlayheadMs}
            />
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
            scribbleMd={scribbleMd}
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
        换模板 ▾
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
                  用「{t.name}」重新整理
                  {t.builtin && <span className="ml-1 text-[10px] uppercase tracking-wider text-text-3">内置</span>}
                </button>
              </li>
            ))}
            <li className="border-t border-line mt-1 pt-1">
              <button
                onClick={() => { setOpen(false); useUI.getState().goTemplates() }}
                className="w-full text-left px-3 py-2 rounded-md hover:bg-bg-overlay text-text-3 text-xs"
              >管理模板…</button>
            </li>
          </ul>
        </>
      )}
    </div>
  )
}

function LiveClock({ meetingId }: { meetingId: string }): JSX.Element {
  const active = useRecorder((s) => s.meeting?.id === meetingId)
  const elapsed = useRecorder((s) => s.elapsedMs)
  return (
    <span className="inline-flex items-center gap-1.5 text-danger font-medium">
      <span className="rec-dot h-1.5 w-1.5 rounded-full bg-danger" />
      REC <span className="tabular-nums">{active ? fmtClock(elapsed) : ''}</span>
    </span>
  )
}

// ── 会中实时布局（Foresight）──────────────────────────────────────
// 左主栏「速记」，右侧「实时转录」+「相关资料」。录音结束回到 Tab 视图。
function LiveMeetingView({
  meeting, scribbleMd, transcriptText,
}: {
  meeting: Meeting
  scribbleMd: string
  transcriptText: string | undefined
}): JSX.Element {
  const captureMode = useRecorder((s) => s.captureMode)
  const missing = useMissingBuiltin(useSettings())
  const captureLabel = captureMode === 'mic+system' ? '麦克风 + 系统音频'
    : captureMode === 'mic-only' ? '仅麦克风' : '音频不可用'

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Live 头部 */}
      <div className="flex items-center gap-3 px-6 h-14 border-b border-line shrink-0">
        <LiveClock meetingId={meeting.id} />
        <h1 className="text-base font-semibold text-text-1 truncate">{meeting.title}</h1>
        <span className="text-[11px] text-text-3 hidden sm:inline">{captureLabel}</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-text-3 hidden md:inline">散会后自动整理成笔记</span>
          <button
            onClick={() => void useRecorder.getState().stop()}
            className="btn-primary text-xs h-8 px-3 bg-danger border-danger"
          >■ 停止</button>
        </div>
      </div>
      {missing.length > 0 && (
        <div className="px-6 py-2 text-xs bg-warning/8 border-b border-warning/30 flex items-center gap-3 shrink-0">
          <span className="text-text-2 flex-1">本地模型（{missingNames(missing)}）还没下载完 —— 录音照常保存在本机，下好后自动转录整理。</span>
          <button onClick={() => useUI.getState().goSettings()} className="btn-outline text-xs h-7 px-3">去下载</button>
        </div>
      )}
      {/* 主体：左速记 / 右（转录 + 相关资料）；窄屏纵向堆叠 */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
        <div className="flex-1 min-w-0 lg:overflow-y-auto p-6">
          <ScribbleEditor meeting={meeting} live />
        </div>
        <aside className="w-full lg:w-[380px] shrink-0 border-t lg:border-t-0 lg:border-l border-line lg:overflow-y-auto p-4 space-y-5">
          <section>
            <LiveCaptionPane meetingId={meeting.id} />
          </section>
          <section>
            <div className="section-title mb-2">相关资料</div>
            <AssistPane meeting={meeting} scribbleMd={scribbleMd} transcriptText={transcriptText} />
          </section>
        </aside>
      </div>
    </div>
  )
}

// ── 会中实时字幕 ─────────────────────────────────────────────────
// 默认关（Chrome 会把音频发到云端识别），一键开启并记住；不支持的浏览器如实说明。
function LiveCaptionPane({ meetingId }: { meetingId: string }): JSX.Element {
  const { status, error, segments, interim } = useCaption()
  const startedAt = useRecorder((s) => s.meeting?.id === meetingId ? s.meeting.startedAt : null)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [segments.length, interim])
  const toggle = (on: boolean): void => {
    if (startedAt) void setLiveCaptionEnabled(on, meetingId, Date.parse(startedAt))
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div className="section-title">实时字幕</div>
        {status === 'on' && <span className="rec-dot h-1.5 w-1.5 rounded-full bg-danger" />}
        {status === 'on' && (
          <button onClick={() => toggle(false)} className="ml-auto text-[11px] text-text-3 hover:text-text-1">关闭</button>
        )}
      </div>
      {status === 'blocked' ? (
        <p className="text-[12px] text-text-3 leading-relaxed">
          本地转录模式：浏览器字幕会把音频发到云端，已禁用。录音只存在本机，散会后由本地模型转录。
        </p>
      ) : status === 'unsupported' ? (
        <p className="text-[12px] text-text-3 leading-relaxed">
          当前浏览器不支持实时字幕（Chrome / Edge / Safari 支持）。录音照常进行，散会后用正式转录生成全文。
        </p>
      ) : status === 'off' || status === 'error' ? (
        <div className="rounded-lg border border-line p-3 text-[12px] text-text-3 leading-relaxed space-y-2">
          <p>边说边出字，不用等散会。用的是浏览器自带的语音识别，免费、不需要 Key；Chrome / Edge 会把音频发到厂商云端识别。</p>
          {error && <p className="text-danger">{error}</p>}
          <button onClick={() => toggle(true)} className="btn-outline text-xs h-7 px-3">开启实时字幕</button>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[50vh] overflow-y-auto text-[13px] leading-relaxed">
          {segments.length === 0 && !interim && <p className="text-text-3 text-[12px]">正在听…</p>}
          {segments.map((seg, i) => (
            <div key={i} className="flex gap-2">
              <span className="font-mono tabular-nums text-[11px] text-text-3 w-10 shrink-0 pt-0.5">{fmtClock(seg.start_ms)}</span>
              <span className="text-text-1">{seg.text}</span>
            </div>
          ))}
          {interim && (
            <div className="flex gap-2">
              <span className="w-10 shrink-0" />
              <span className="text-text-3">{interim}</span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  )
}

// ── 速记 Scribble ─────────────────────────────────────────────────
// 一行一条 bullet，键入即存（db.scribbles）；录音中带时间轴锚点 t_ms。
function ScribbleEditor({
  meeting, live, onSeek,
}: {
  meeting: Meeting
  live: boolean
  onSeek?: (ms: number) => void
}): JSX.Element {
  const rows = useLiveQuery(
    () => db.scribbles.where('meeting_id').equals(meeting.id).sortBy('created_at'),
    [meeting.id],
  ) ?? []
  const elapsedMs = useRecorder((s) => s.meeting?.id === meeting.id ? s.elapsedMs : null)
  const [draft, setDraft] = useState('')

  // 停止录音会切走本视图、卸载输入框 —— onBlur 不触发，故用 ref 在卸载时补存那条未回车的速记
  const draftRef = useRef('')
  draftRef.current = draft
  const liveRef = useRef(live)
  liveRef.current = live
  const elapsedRef = useRef(elapsedMs)
  elapsedRef.current = elapsedMs
  useEffect(() => () => {
    const text = draftRef.current.trim()
    if (!text) return
    void db.scribbles.add({
      id: uid(), meeting_id: meeting.id, t_ms: liveRef.current ? (elapsedRef.current ?? 0) : null, text, created_at: now(),
    })
  }, [meeting.id])

  async function commit(): Promise<void> {
    const text = draft.trim()
    if (!text) return
    draftRef.current = ''
    setDraft('')
    await db.scribbles.add({
      id: uid(),
      meeting_id: meeting.id,
      t_ms: live ? (elapsedMs ?? 0) : null,
      text,
      created_at: now(),
    })
  }

  return (
    <div className={`rounded-xl border bg-bg-raise ${live ? 'border-danger/25 shadow-[0_0_0_4px_color-mix(in_oklch,var(--danger)_6%,transparent)]' : 'border-line'}`}>
      <div className="flex items-center gap-2 px-4 h-10 border-b border-line text-xs text-text-3">
        <span className="font-medium text-text-2">速记</span>
        <span>{live ? '只写关键词，别和转录较劲 — 回车存一条' : '会中的速记；点「整理笔记」用转录扩写'}</span>
        <span className="ml-auto">{rows.length} 条</span>
      </div>
      <div className="px-4 py-3 space-y-1.5 min-h-[180px]">
        {rows.map((r) => (
          <BulletRow key={r.id} row={r} onSeek={onSeek} />
        ))}
        {/* 活动输入行（设计里的 caret 行） */}
        <div className="flex items-baseline gap-3">
          <span className="font-mono tabular-nums text-[11px] text-text-disabled w-12 shrink-0 text-right">
            {live ? fmtClock(elapsedMs ?? 0) : '·'}
          </span>
          <span className="text-text-disabled select-none">-</span>
          <input
            autoFocus={live}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void commit() }
            }}
            onBlur={() => void commit()}
            placeholder={rows.length === 0 ? 'q4 预算?? / 上线风险 / @法务 合同…' : '再记一条…'}
            className="flex-1 min-w-0 bg-transparent outline-none text-[15px] leading-7 text-text-1 placeholder:text-text-disabled"
          />
        </div>
      </div>
    </div>
  )
}

// 单条 bullet：时间戳（可跳播）+ 就地编辑；清空后失焦即删除。
function BulletRow({
  row, onSeek,
}: {
  row: Scribble
  onSeek?: (ms: number) => void
}): JSX.Element {
  const [text, setText] = useState(row.text)

  async function save(): Promise<void> {
    const v = text.trim()
    if (v === row.text) return
    if (!v) { await db.scribbles.delete(row.id); return }
    await db.scribbles.update(row.id, { text: v })
  }

  return (
    <div className="group flex items-baseline gap-3">
      {row.t_ms != null && onSeek ? (
        <button
          onClick={() => onSeek(row.t_ms!)}
          className="font-mono tabular-nums text-[11px] text-text-3 hover:text-accent w-12 shrink-0 text-right transition-colors"
          title={`跳到 ${fmtClock(row.t_ms)} 播放`}
        >{fmtClock(row.t_ms)}</button>
      ) : (
        <span className="font-mono tabular-nums text-[11px] text-text-3 w-12 shrink-0 text-right">
          {row.t_ms != null ? fmtClock(row.t_ms) : '·'}
        </span>
      )}
      <span className="text-text-3 select-none">-</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur() }}
        onBlur={() => void save()}
        className="flex-1 min-w-0 bg-transparent outline-none text-[15px] leading-7 text-text-1"
      />
      <button
        onClick={() => void db.scribbles.delete(row.id)}
        className="opacity-0 group-hover:opacity-100 text-text-disabled hover:text-danger text-xs shrink-0 transition-opacity"
        title="删除这条"
      >✕</button>
    </div>
  )
}

// ── 待确认待办（笔记 Tab 顶部）─────────────────────────────────────
// 每条一行：✓ 确认（挂到建议 KR，没有建议则进 Inbox）/ ✕ 丢弃；
// 建议 KR 以 chip 显示，点 chip 可取消挂载改进 Inbox。「全部确认」按每行当前选择一次落库。
function PendingTodos({
  todos, krs, onJumpToTranscript,
}: {
  todos: Todo[]
  krs: Todo[]
  onJumpToTranscript: (t: Todo) => void
}): JSX.Element {
  const [skipKr, setSkipKr] = useState<Set<string>>(new Set())
  const targetOf = (t: Todo): Todo | null => skipKr.has(t.id) ? null : suggestKr(t.title, krs)
  const toggleKr = (id: string): void => setSkipKr((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  return (
    <section className="card p-4 border-accent/30">
      <div className="flex items-center gap-2 mb-2">
        <div className="section-title">会议待办 · {todos.length}</div>
        <span className="text-[11px] text-text-3 hidden sm:inline">AI 从转录里提取，确认后进入任务</span>
        <button
          onClick={() => void Promise.all(todos.map((t) => attachTask(t, targetOf(t))))}
          className="btn-primary text-xs h-7 px-3 ml-auto"
        >全部确认</button>
      </div>
      <ul className="divide-y divide-line">
        {todos.map((t) => {
          const kr = suggestKr(t.title, krs)
          const target = targetOf(t)
          return (
            <li key={t.id} className="flex items-start gap-2.5 py-2">
              <button
                onClick={() => void attachTask(t, target)}
                className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-line-strong hover:border-accent hover:bg-accent/10 text-[11px] text-accent"
                aria-label="确认"
                title={target ? `确认并挂到「${target.title}」` : '确认，进 Inbox'}
              >✓</button>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-1 leading-snug">{t.title}</div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[11px] text-text-3">
                  {t.assignee && <span>@{t.assignee}</span>}
                  {t.due_date && <span>{t.due_date}</span>}
                  {t.transcript_span && (
                    <button onClick={() => onJumpToTranscript(t)} className="hover:text-accent truncate max-w-[32ch]" title="跳到转录原文">
                      「{t.transcript_span.quote || fmtClock(t.transcript_span.start_ms)}」
                    </button>
                  )}
                  {kr && (
                    <button
                      onClick={() => toggleKr(t.id)}
                      className={`px-1.5 rounded border transition-colors ${target ? 'border-accent/40 bg-accent/8 text-accent' : 'border-line text-text-3 line-through'}`}
                      title={target ? '点一下改为只进 Inbox' : '点一下恢复挂到这个 KR'}
                    >→ {levelLabel(kr)} · {kr.title}</button>
                  )}
                  {!kr && <span>→ Inbox</span>}
                </div>
              </div>
              <button
                onClick={() => void discardTask(t)}
                className="mt-0.5 text-text-disabled hover:text-danger text-xs shrink-0"
                aria-label="丢弃"
                title="不是待办，丢弃"
              >✕</button>
            </li>
          )
        })}
      </ul>
    </section>
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

  // debounce 200ms 只作用于 query 字符串；命中由 useMemo 派生。
  // 不能在 effect 里依赖 entries 再 setState：`useLiveQuery() ?? []` 每次渲染都是新数组 → 无限渲染（会中页面卡死）
  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(effectiveQuery), 200)
    return () => clearTimeout(t)
  }, [effectiveQuery])
  const hits = useMemo(
    () => debouncedQuery ? retrieveKnowledge(debouncedQuery, entries, 8) : [],
    [debouncedQuery, entries],
  )

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
      // 本地模型（Ollama 等）无需 Key：按当前生效配置判断，而不是只看云端 Key
      const llm = resolveLLMConfig(settings)
      if (!llm.is_local && !llm.api_key) {
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