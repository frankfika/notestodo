import { db } from '../db/db'
import type { AudioChunk, Meeting } from '../types'

export interface MergedAudio {
  blob: Blob
  mimeType: string
  durationMs: number
  sizeBytes: number
}

/**
 * Concatenate every AudioChunk for a meeting (in `seq` order) into a single
 * Blob. The mime type comes from the first chunk's `blob.type`, falling back
 * to `meeting.audio.format` if the chunk blob doesn't carry one (Safari
 * sometimes emits empty mime types for Opus-in-WebM).
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

  // 排序规则（防御性，配合引擎修复的语义）：
  //   1. seq >= 0 的数据分片按 seq 升序
  //   2. seq=-1 的 tail chunk（停止时最终 flush）永远排最后
  //   3. 空 placeholder（size=0，seq=0）不产生可听内容，顺序无关
  // 旧数据兼容：修复前 tail 曾被写成 seq=-1 且 sortBy 会把它排最前。
  const ordered = chunks.slice().sort((a, b) => {
    const ta = a.seq === -1 ? 1 : 0
    const tb = b.seq === -1 ? 1 : 0
    if (ta !== tb) return ta - tb
    return a.seq - b.seq
  })

  const withAudio = ordered.filter((c) => c.blob && c.blob.size > 0)
  if (withAudio.length === 0) {
    throw new Error(`No audio data for meeting ${meetingId} (only empty placeholders)`)
  }

  const first = withAudio[0] as AudioChunk
  const mimeType =
    (first.blob && first.blob.type) || (await fallbackMimeFor(meetingId))

  // BlobPart[] accepts blobs; the resulting Blob inherits the mime passed
  // in its options bag if the chunks' types are empty.
  const parts: Blob[] = withAudio.map((c) => c.blob)
  const blob = new Blob(parts, { type: mimeType })

  const durationMs = withAudio.reduce((sum, c) => sum + (c.duration_ms || 0), 0)
  const sizeBytes = blob.size

  return { blob, mimeType, durationMs, sizeBytes }
}

async function fallbackMimeFor(meetingId: string): Promise<string> {
  const meeting = (await db.meetings.get(meetingId)) as Meeting | undefined
  return meeting?.audio.format || 'audio/webm'
}
