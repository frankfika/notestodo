import { db } from '../db/db'
import { mergeAudioChunks } from '../audio/merge'
import { getAsrProvider } from '../transcribe/types'
import { getSettings } from '../db/settings'
import { now } from '../lib/id'
import { resolveASRConfig, type Meeting, type Transcript, type TranscriptSegment } from '../types'
import { runSummarizePipeline } from './summarize'
import { autoPolish } from './polish'

/**
 * Transcription pipeline entry point.
 *
 * Flow:
 *   1. Mark meeting as 'processing'.
 *   2. Merge audio chunks into a single Blob.
 *   3. Resolve the ASR adapter from settings and call it.
 *   4. Persist a Transcript row.
 *   5. Mark meeting as 'transcribed' and hand off to the summariser.
 *
 * Errors are caught and persisted on the meeting (`status='failed'`,
 * `error=…`). The caller (engine / resume) decides whether to retry.
 */
export async function runTranscribePipeline(meetingId: string): Promise<void> {
  const meeting = await db.meetings.get(meetingId)
  if (!meeting) throw new Error(`Meeting ${meetingId} not found`)

  // Idempotent: if a transcript already exists for this meeting, skip
  // straight to summarisation.
  const existing = await db.transcripts
    .where('meeting_id')
    .equals(meetingId)
    .first()
  if (existing) {
    await db.meetings.update(meetingId, {
      status: 'transcribed',
      updated_at: now(),
    })
    await runSummarizePipeline(meetingId)
    return
  }

  await db.meetings.update(meetingId, {
    status: 'processing',
    error: undefined,
    updated_at: now(),
  })

  let merged
  try {
    merged = await mergeAudioChunks(meetingId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.meetings.update(meetingId, {
      status: 'failed',
      error: `音频合并失败：${msg}`,
      updated_at: now(),
    })
    return
  }

  // Reconcile meeting.audio metadata with the merged result.
  await db.meetings.update(meetingId, {
    audio: {
      format: merged.mimeType,
      codec: meeting.audio.codec,
      duration_ms: merged.durationMs,
      chunk_count: meeting.audio.chunk_count,
      size_bytes: merged.sizeBytes,
      gaps: meeting.audio.gaps ?? [],
    },
    updated_at: now(),
  })

  const settings = await getSettings()
  const cfg = resolveASRConfig(settings)
  const provider = getAsrProvider(settings)
  if (!provider) {
    await db.meetings.update(meetingId, {
      status: 'failed',
      error: `未知的 ASR provider：${cfg.provider}`,
      updated_at: now(),
    })
    return
  }

  let segments: TranscriptSegment[]
  try {
    segments = await provider.transcribe({
      blob: merged.blob,
      mimeType: merged.mimeType,
      durationMs: merged.durationMs,
      settings,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.meetings.update(meetingId, {
      status: 'failed',
      error: `转录失败：${msg}`,
      updated_at: now(),
    })
    return
  }

  const transcript: Transcript = {
    id: crypto.randomUUID(),
    meeting_id: meetingId,
    language: 'zh',
    // Phase-3: 记录 actual 调用（local 时为 openai-whisper，对调试有意义）
    engine: cfg.provider,
    engine_meta: {
      asr_mode: cfg.is_local ? 'local' : 'cloud',
      asr_model: cfg.model,
      asr_base_url: cfg.base_url,
      mime_type: merged.mimeType,
    },
    segments,
    speaker_names: {},
    created_at: now(),
    updated_at: now(),
    deleted_at: null,
    sync_version: 0,
  }
  await db.transcripts.put(transcript)

  await db.meetings.update(meetingId, {
    status: 'transcribed',
    updated_at: now(),
  })

  // Hand off：纪要/待办提取 与 速记整理 并行（整理失败不影响纪要）
  await Promise.all([runSummarizePipeline(meetingId), autoPolish(meetingId)])
}
