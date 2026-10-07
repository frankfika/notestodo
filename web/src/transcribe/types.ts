import type { AppSettings, TranscriptSegment } from '../types'
import { minimaxProvider } from './minimax'
import { openaiWhisperProvider } from './openai-whisper'
import { deepgramProvider } from './deepgram'

/**
 * ASR provider adapter interface.
 *
 * Each implementation is a pure function: given an audio blob + settings,
 * return the list of transcript segments. Speaker labels are normalised
 * to "说话人 N" by each adapter; cross-chunk merging is the adapter's
 * responsibility (see minimax.ts for an example).
 */
export interface AsrProvider {
  id: 'minimax' | 'openai-whisper' | 'deepgram'
  transcribe(input: {
    blob: Blob
    mimeType: string
    durationMs: number
    settings: AppSettings
    language?: string
  }): Promise<TranscriptSegment[]>
}

/**
 * Lookup registry. Returns the adapter matching `settings.asr_provider`,
 * or undefined if the provider is unknown.
 */
export function getAsrProvider(
  id: AppSettings['asr_provider'],
): AsrProvider | undefined {
  switch (id) {
    case 'minimax':
      return minimaxProvider
    case 'openai-whisper':
      return openaiWhisperProvider
    case 'deepgram':
      return deepgramProvider
    default:
      return undefined
  }
}
