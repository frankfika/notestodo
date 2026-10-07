import { db } from '../db/db'
import type { AudioChunk, Meeting } from '../types'

export interface MergedAudio {
  blob: Blob
  mimeType: string
  durationMs: number
  sizeBytes: number
}

/**
 * 确定性排序（共享给 playback UI、mergeAudioChunks、finalizeMeeting —— 三处必须一致）：
 *   1. seq >= 0 的数据分片按 seq 升序
 *   2. seq=-1 的 tail chunk（停止时最终 flush）永远排最后
 * 旧数据兼容：早期版本 tail 曾被写成 seq=-1 且 sortBy 会把它排最前。
 */
export function chunksInOrder(chunks: AudioChunk[]): AudioChunk[] {
  return chunks.slice().sort((a, b) => {
    const ta = a.seq === -1 ? 1 : 0
    const tb = b.seq === -1 ? 1 : 0
    if (ta !== tb) return ta - tb
    return a.seq - b.seq
  })
}

/**
 * Concatenate every AudioChunk for a meeting (in correct seq order) into a
 * single Blob. The mime type comes from the first data chunk's blob.type,
 * falling back to `meeting.audio.format` if the chunk blob doesn't carry one
 * (Safari sometimes emits empty mime types for Opus-in-WebM).
 *
 * Duration is approximated as the sum of `duration_ms` across chunks — good
 * enough for MVP display purposes; an exact value would require re-decoding
 * the blob through OfflineAudioContext, which we want to avoid here.
 */
export async function mergeAudioChunks(meetingId: string): Promise<MergedAudio> {
  const chunks = await db.audioChunks
    .where('meeting_id')
    .equals(meetingId)
    .toArray()

  if (chunks.length === 0) {
    throw new Error(`No audio chunks for meeting ${meetingId}`)
  }

  const ordered = chunksInOrder(chunks).filter((c) => c.blob && c.blob.size > 0)
  if (ordered.length === 0) {
    throw new Error(`No audio data for meeting ${meetingId} (only empty placeholders)`)
  }

  const first = ordered[0] as AudioChunk
  const mimeType =
    (first.blob && first.blob.type) || (await fallbackMimeFor(meetingId))

  // BlobPart[] accepts blobs; the resulting Blob inherits the mime passed
  // in its options bag if the chunks' types are empty.
  const parts: Blob[] = ordered.map((c) => c.blob)
  const blob = new Blob(parts, { type: mimeType })

  const durationMs = ordered.reduce((sum, c) => sum + (c.duration_ms || 0), 0)
  const sizeBytes = blob.size

  return { blob, mimeType, durationMs, sizeBytes }
}

async function fallbackMimeFor(meetingId: string): Promise<string> {
  const meeting = (await db.meetings.get(meetingId)) as Meeting | undefined
  return meeting?.audio.format || 'audio/webm'
}
