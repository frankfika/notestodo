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
    .sortBy('seq')

  if (chunks.length === 0) {
    throw new Error(`No audio chunks for meeting ${meetingId}`)
  }

  const first = chunks[0] as AudioChunk
  const mimeType =
    (first.blob && first.blob.type) || (await fallbackMimeFor(meetingId))

  // BlobPart[] accepts blobs; the resulting Blob inherits the mime passed
  // in its options bag if the chunks' types are empty.
  const parts: Blob[] = chunks.map((c) => c.blob)
  const blob = new Blob(parts, { type: mimeType })

  const durationMs = chunks.reduce((sum, c) => sum + (c.duration_ms || 0), 0)
  const sizeBytes = blob.size

  return { blob, mimeType, durationMs, sizeBytes }
}

async function fallbackMimeFor(meetingId: string): Promise<string> {
  const meeting = (await db.meetings.get(meetingId)) as Meeting | undefined
  return meeting?.audio.format || 'audio/webm'
}
