import { db } from '../db/db'
import { now, uid } from '../lib/id'
import { setRecorderPartial, useRecorder } from '../state/recorder'
import { runTranscribePipeline } from '../pipeline/transcribe'
import type {
  AudioChunk,
  Meeting,
  Note,
} from '../types'

/**
 * MediaRecorder-driven recording engine.
 *
 * Design goals (from docs/SHARED_SPEC.md + DESIGN.md §4.3):
 *  - Each chunk is persisted to IndexedDB the instant `ondataavailable`
 *    fires, so a tab crash / refresh loses at most one chunk (~5 min).
 *  - Browsers can yank the mic on visibilitychange / pagehide; we react by
 *    closing the dead track, recording the gap, and reopening getUserMedia.
 *  - Stopping the recorder marks the meeting `processing` and kicks off
 *    the transcription pipeline — the store does NOT block on it.
 *
 * Lifecycle:
 *   bindRecorderEngine()         called once from bootstrap.ts
 *   startRecorder({ title })     UI / hotkey starts the engine
 *   stopRecorder()               UI / hotkey stops it; returns meetingId
 *
 * All engine state lives in module-level singletons — only one meeting is
 * ever active at a time, which matches the design (one mic, one session).
 */

// ── Module state ──────────────────────────────────────────────────────────────

interface ActiveEngine {
  meetingId: string
  stream: MediaStream
  recorder: MediaRecorder
  mimeType: string
  /** elapsed ms reported to the store every 250 ms */
  startedAtMs: number
  /** wall-clock offset between MediaRecorder timeslice boundaries and audio gaps */
  lastChunkAt: number | null
  /** monotonic chunk sequence number */
  seq: number
  /** setInterval handle for the elapsed-timer pump */
  timer: number | null
  /** setInterval handle for the audio level pump */
  levelTimer: number | null
  /** AudioContext + AnalyserNode for live level metering */
  audioCtx: AudioContext | null
  analyser: AnalyserNode | null
  /** pending resume after a visibility/track-ended interruption */
  resuming: boolean
}

let active: ActiveEngine | null = null

/** 5-minute chunks — keeps memory pressure bounded and is the unit of
 *  crash safety (one lost chunk = at most 5 min). */
const TIMESLICE_MS = 5 * 60 * 1000

/** Hidden visibility / pagehide listeners — kept module-scoped so we can
 *  unbind on engine teardown. */
let bound: boolean = false

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Replace the placeholder `start` / `stop` actions in the recorder store
 * with the real MediaRecorder-driven implementations. Idempotent.
 */
export function bindRecorderEngine(): void {
  useRecorder.setState({
    start: (title?: string) => startRecorder({ title }),
    // The store contract is `() => Promise<void>`; the real implementation
    // returns the meetingId for callers that need it (e.g. command palette
    // "go to meeting" UX), but UI code only awaits the void return.
    stop: () => stopRecorder().then(() => undefined),
    pauseMarker: () => {
      const phase = useRecorder.getState().phase
      if (phase !== 'recording') return
      // A pause marker is just a UI hint — the engine itself tracks gaps
      // automatically via visibility / pagehide.
      useRecorder.setState({ interrupted: true })
    },
  })
  if (!bound) {
    bindLifecycleListeners()
    bound = true
  }
}

export async function startRecorder(opts?: { title?: string }): Promise<void> {
  if (active) {
    // Idempotent: ignore double-taps.
    return
  }
  setRecorderPartial({
    phase: 'starting',
    error: null,
    interrupted: false,
    elapsedMs: 0,
    chunkCount: 0,
  })

  let stream: MediaStream
  try {
    stream = await acquireStream()
  } catch (e) {
    const msg = describeError(e)
    setRecorderPartial({ phase: 'error', error: msg })
    throw e instanceof Error ? e : new Error(msg)
  }

  const mimeType = pickMimeType()
  const meetingId = await createMeetingWithFirstChunk(
    opts?.title ?? defaultTitle(),
    mimeType,
  )

  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const startedAtMs = Date.now()

  // 实时电平表：AudioContext + AnalyserNode，从同一 stream 拉取但不录音流本身。
  // analyser 的目的是"让用户看见麦在响"——录音仍走 MediaRecorder。
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (AC) {
      audioCtx = new AC()
      const source = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
    }
  } catch (e: unknown) {
    // 不影响录音主路径
    console.warn('AudioContext analyser 初始化失败', e)
  }

  active = {
    meetingId,
    stream,
    recorder,
    mimeType,
    startedAtMs,
    lastChunkAt: null,
    seq: 1, // 0 is reserved for the placeholder row created with the meeting
    timer: null,
    levelTimer: null,
    audioCtx,
    analyser,
    resuming: false,
  }

  // Bind handlers AFTER active is set so the first ondataavailable can see
  // it; but the final chunk on stop() may fire after teardown — handleData
  // Available tolerates that.
  recorder.ondataavailable = (ev) => handleDataAvailable(meetingId, ev, () => {
    if (!active || active.meetingId !== meetingId) return null
    const s = active.seq++
    active.lastChunkAt = Date.now()
    return s
  })
  recorder.onerror = (ev) => handleRecorderError(ev)
  recorder.onstop = () => {
    // Final flush — fired by MediaRecorder.stop(); the last ondataavailable
    // has already persisted its chunk via the closure above.
  }

  // Stream-level interruption (system killed the mic): try to reopen.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => handleTrackEnded(meetingId))
  }

  try {
    recorder.start(TIMESLICE_MS)
  } catch (e) {
    teardown()
    const msg = describeError(e)
    setRecorderPartial({ phase: 'error', error: `MediaRecorder.start 失败：${msg}` })
    throw e instanceof Error ? e : new Error(msg)
  }

  const timer = window.setInterval(() => {
    if (!active) return
    setRecorderPartial({ elapsedMs: Date.now() - active.startedAtMs })
  }, 250)

  active.timer = timer

  // 实时电平（0..1）每 100ms 上报一次，让 UI 看见麦在响
  const levelBuf = active.analyser ? new Uint8Array(active.analyser.fftSize) : null
  const levelTimer = window.setInterval(() => {
    if (!active || !active.analyser || !levelBuf) return
    active.analyser.getByteTimeDomainData(levelBuf)
    let sum = 0
    for (let i = 0; i < levelBuf.length; i++) {
      const v = (levelBuf[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / levelBuf.length)
    setRecorderPartial({ audioLevel: Math.min(1, rms * 2.5) })
  }, 100)
  active.levelTimer = levelTimer

  setRecorderPartial({
    phase: 'recording',
    meeting: {
      id: meetingId,
      title: opts?.title ?? defaultTitle(),
      startedAt: new Date(startedAtMs).toISOString(),
    },
    chunkCount: 1,
  })
}

export async function stopRecorder(): Promise<string | null> {
  if (!active) return null
  const meetingId = active.meetingId
  setRecorderPartial({ phase: 'stopping' })

  // 关键：recorder.stop() 会触发最后一次 ondataavailable（tail chunk）。
  // 必须保持 active 直到它落库，否则 allocateSeq 返回 null → tail chunk
  // 被写成 seq=-1，merge/finalise 按 seq 排序时最后一段音频会排到最前
  //（长录音转录错序的根因）。先记下引用再等待。
  const recorder = active.recorder
  const stream = active.stream
  const timer = active.timer
  const finalFlush = new Promise<void>((resolve) => {
    const prevOnData = recorder.ondataavailable
    recorder.ondataavailable = (ev) => {
      // 仍走原 handler —— active 尚未清空，tail chunk 拿到真实 seq
      if (prevOnData) prevOnData.call(recorder, ev)
      resolve()
    }
    // 兜底：某些实现 stop() 后不再派发 dataavailable（如无数据可冲）
    setTimeout(resolve, 1500)
  })

  // Stop the recorder (this triggers one final ondataavailable + onstop).
  try {
    if (recorder.state !== 'inactive') {
      recorder.stop()
    }
  } catch {
    // ignore — we'll still tear everything down.
  }
  await finalFlush

  // Stop all tracks so the mic indicator goes away.
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // ignore
    }
  }

  if (timer !== null) {
    clearInterval(timer)
  }
  active = null

  // Update meeting.ended_at and persist final audio stats. We do this
  // BEFORE kicking off the pipeline so the UI sees a consistent state.
  await finaliseMeeting(meetingId)

  setRecorderPartial({
    phase: 'idle',
    meeting: null,
    elapsedMs: 0,
    chunkCount: 0,
    interrupted: false,
  })

  // Fire and forget — the pipeline updates meeting.status itself.
  void runTranscribePipeline(meetingId).catch((e) => {
    console.error('转录管线失败', e)
  })

  return meetingId
}

// ── Stream / mime detection ───────────────────────────────────────────────────

async function acquireStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 48000,
    },
  })
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=aac',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
]

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const cand of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(cand)) return cand
  }
  return ''
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    // DOMException names are more user-friendly than codes for NotAllowed.
    const dom = e as Error & { name?: string }
    switch (dom.name) {
      case 'NotAllowedError':
        return '麦克风权限被拒绝。请在浏览器地址栏的权限菜单里允许后重试。'
      case 'NotFoundError':
        return '未找到可用的麦克风设备。'
      case 'NotReadableError':
        return '麦克风被其他程序占用，请关闭后重试。'
      default:
        return e.message || e.name || '未知错误'
    }
  }
  return String(e)
}

// ── DB writes ─────────────────────────────────────────────────────────────────

async function createMeetingWithFirstChunk(
  title: string,
  mimeType: string,
): Promise<string> {
  const meetingId = uid()
  const noteId = uid()
  const createdAt = now()

  // 如果 Today 页点了"为日历事件录制"，会预先在 KV 里塞一条 meta
  const metaRow = await db.kv.get('pending_meeting_meta').catch(() => null)
  const meta = metaRow?.value as { title?: string; start_at?: string; calendar_event_id?: string } | undefined
  if (meta) {
    await db.kv.delete('pending_meeting_meta')
  }

  const finalTitle = meta?.title || title
  const finalStartedAt = meta?.start_at || createdAt

  const meeting: Meeting = {
    id: meetingId,
    title: finalTitle,
    source: meta?.calendar_event_id ? 'calendar' : 'manual',
    calendar_event_id: meta?.calendar_event_id,
    status: 'recording',
    started_at: finalStartedAt,
    audio: {
      format: mimeType || 'audio/webm',
      codec: mimeType.includes('opus')
        ? 'opus'
        : mimeType.includes('aac')
          ? 'aac'
          : '',
      duration_ms: 0,
      chunk_count: 0,
      size_bytes: 0,
      gaps: [],
    },
    note_id: noteId,
    created_at: createdAt,
    updated_at: createdAt,
    deleted_at: null,
    sync_version: 0,
  }

  const note: Note = {
    id: noteId,
    title: finalTitle,
    body_md: '',
    meeting_id: meetingId,
    todo_ids: [],
    pinned: false,
    created_at: createdAt,
    updated_at: createdAt,
    deleted_at: null,
    sync_version: 0,
  }

  // Reserve a placeholder chunk row so the meeting has at least one chunk
  // reference. The real first chunk will overwrite/append on the next
  // timeslice.
  const placeholder: AudioChunk = {
    id: uid(),
    meeting_id: meetingId,
    seq: 0,
    blob: new Blob([], { type: mimeType }),
    size_bytes: 0,
    duration_ms: 0,
    created_at: createdAt,
  }

  await db.transaction(
    'rw',
    db.meetings,
    db.notes,
    db.audioChunks,
    async () => {
      await db.meetings.put(meeting)
      await db.notes.put(note)
      await db.audioChunks.put(placeholder)
    },
  )

  return meetingId
}

async function handleDataAvailable(
  meetingId: string,
  ev: BlobEvent,
  allocateSeq: () => number | null,
): Promise<void> {
  if (!ev.data || ev.data.size === 0) return

  // Allocate the next sequence number. The allocator returns null when
  // the engine is no longer tracking this meeting (e.g. the recorder
  // somehow fires after stop). We still persist the chunk in that case —
  // just with seq=-1 so the row sorts last and is recognisably a tail
  // chunk from a torn-down recorder.
  const seq = allocateSeq()

  const nowIso = now()
  const chunk: AudioChunk = {
    id: uid(),
    meeting_id: meetingId,
    seq: seq ?? -1,
    blob: ev.data,
    size_bytes: ev.data.size,
    duration_ms: 0, // duration is recomputed in finaliseMeeting()
    created_at: nowIso,
  }

  try {
    await db.audioChunks.put(chunk)
    const meeting = (await db.meetings.get(meetingId)) as Meeting | undefined
    if (meeting) {
      await db.meetings.update(meetingId, {
        audio: {
          ...meeting.audio,
          chunk_count: meeting.audio.chunk_count + 1,
          size_bytes: meeting.audio.size_bytes + ev.data.size,
        },
        updated_at: nowIso,
      })
    }
    if (seq !== null) setRecorderPartial({ chunkCount: seq })
  } catch (e) {
    console.error('保存录音分片失败', e)
  }
}

async function handleRecorderError(ev: Event): Promise<void> {
  const errMsg =
    (ev as ErrorEvent).message ||
    (ev as { error?: { message?: string } }).error?.message ||
    'MediaRecorder 报告错误'
  setRecorderPartial({ phase: 'error', error: errMsg })
}

async function handleTrackEnded(meetingId: string): Promise<void> {
  // Mic got yanked (system, hardware, another app). Try to reopen silently.
  if (!active || active.meetingId !== meetingId) return
  if (active.resuming) return
  active.resuming = true
  setRecorderPartial({ interrupted: true })

  // Mark the gap in meeting.audio.gaps
  try {
    const meeting = (await db.meetings.get(meetingId)) as Meeting | undefined
    if (meeting) {
      const nowMs = Date.now()
      const offsetMs = nowMs - active.startedAtMs
      const lastTs = active.lastChunkAt
        ? active.lastChunkAt - active.startedAtMs
        : offsetMs
      await db.meetings.update(meetingId, {
        audio: {
          ...meeting.audio,
          gaps: [...(meeting.audio.gaps ?? []), [lastTs, offsetMs]],
        },
        updated_at: now(),
      })
    }
  } catch (e) {
    console.error('记录录音中断区间失败', e)
  }

  // Try to reopen the mic. If it fails, mark error and stay put.
  try {
    const stream = await acquireStream()
    // Replace the stream on the active recorder.
    active.stream = stream
    const recorder = new MediaRecorder(
      stream,
      active.mimeType ? { mimeType: active.mimeType } : undefined,
    )
    active.recorder = recorder
    recorder.ondataavailable = (e) => handleDataAvailable(meetingId, e, () => {
      if (!active || active.meetingId !== meetingId) return null
      const s = active.seq++
      active.lastChunkAt = Date.now()
      return s
    })
    recorder.onerror = (e) => void handleRecorderError(e)
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => handleTrackEnded(meetingId))
    }
    recorder.start(TIMESLICE_MS)
    active.resuming = false
    setRecorderPartial({ interrupted: false, error: null })
  } catch (e) {
    active.resuming = false
    const msg = describeError(e)
    setRecorderPartial({
      phase: 'error',
      error: `录音中断且无法恢复：${msg}`,
    })
  }
}

async function finaliseMeeting(meetingId: string): Promise<void> {
  const chunks = await db.audioChunks
    .where('meeting_id')
    .equals(meetingId)
    .toArray()
  // 与 mergeAudioChunks 一致：数据分片按 seq，tail(-1) 最后；空 placeholder 不计
  chunks.sort((a, b) => {
    const ta = a.seq === -1 ? 1 : 0
    const tb = b.seq === -1 ? 1 : 0
    if (ta !== tb) return ta - tb
    return a.seq - b.seq
  })
  const dataChunks = chunks.filter((c) => c.blob && c.blob.size > 0)
  const meeting = (await db.meetings.get(meetingId)) as Meeting | undefined
  if (!meeting) return

  const totalDuration = dataChunks.reduce((s, c) => s + c.duration_ms, 0)
  const totalSize = dataChunks.reduce((s, c) => s + c.size_bytes, 0)

  await db.meetings.update(meetingId, {
    ended_at: now(),
    audio: {
      ...meeting.audio,
      duration_ms: totalDuration,
      chunk_count: dataChunks.length,
      size_bytes: totalSize,
    },
    updated_at: now(),
  })
}

function teardown(): void {
  if (!active) return
  try {
    if (active.recorder.state !== 'inactive') active.recorder.stop()
  } catch {
    // ignore
  }
  for (const track of active.stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // ignore
    }
  }
  if (active.timer !== null) clearInterval(active.timer)
  if (active.levelTimer !== null) clearInterval(active.levelTimer)
  if (active.audioCtx) {
    try {
      void active.audioCtx.close()
    } catch {
      // ignore
    }
  }
  setRecorderPartial({ audioLevel: 0 })
  active = null
}

// ── Visibility / page lifecycle ───────────────────────────────────────────────

function bindLifecycleListeners(): void {
  if (typeof window === 'undefined') return

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && active) {
      // Don't tear down here — Chrome keeps the recorder alive when the
      // tab is hidden for a few seconds. Just mark the UI as interrupted
      // and let handleTrackEnded drive the recovery if the mic actually
      // gets yanked.
      setRecorderPartial({ interrupted: true })
    } else if (document.visibilityState === 'visible' && active) {
      setRecorderPartial({ interrupted: false })
    }
  })

  window.addEventListener('pagehide', () => {
    if (!active) return
    // Flush current state into DB and mark ended_at — pipeline resumes on
    // next bootstrap via resumePendingJobs().
    const meetingId = active.meetingId
    // Don't await — pagehide doesn't wait for promises.
    void (async () => {
      try {
        await finaliseMeeting(meetingId)
        await db.meetings.update(meetingId, {
          status: 'processing',
          updated_at: now(),
        })
      } catch (e) {
        console.error('pagehide 保存会议状态失败', e)
      }
    })()
  })
}

// ── Defaults ──────────────────────────────────────────────────────────────────

function defaultTitle(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `会议 · ${stamp}`
}
