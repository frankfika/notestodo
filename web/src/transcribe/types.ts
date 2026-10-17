import type { AppSettings, TranscriptSegment } from '../types'
import { resolveASRConfig } from '../types'
import { minimaxProvider } from './minimax'
import { openaiWhisperProvider } from './openai-whisper'
import { deepgramProvider } from './deepgram'
import { builtinAsrProvider } from './builtin'

/**
 * ASR provider adapter interface.
 *
 * Each implementation is a pure function: given an audio blob + settings,
 * return the list of transcript segments. Speaker labels are normalised
 * to "说话人 N" by each adapter; cross-chunk merging is the adapter's
 * responsibility (see minimax.ts for an example).
 */
export interface AsrProvider {
  id: 'minimax' | 'openai-whisper' | 'deepgram' | 'builtin'
  transcribe(input: {
    blob: Blob
    mimeType: string
    durationMs: number
    settings: AppSettings
    language?: string
    /** 人名 / 术语热词（支持的引擎用来提高专有名词准确率） */
    hotwords?: string[]
  }): Promise<TranscriptSegment[]>
}

/**
 * Lookup registry (Phase-3). Resolves the adapter through `resolveASRConfig`,
 * so `asr_mode === 'local'` is honoured: local forces OpenAI Whisper-compatible
 * regardless of `settings.asr_provider` (minimax/deepgram are cloud-only).
 */
export function getAsrProvider(settings: AppSettings): AsrProvider | undefined {
  const cfg = resolveASRConfig(settings)
  switch (cfg.provider) {
    case 'minimax':
      return minimaxProvider
    case 'openai-whisper':
      return openaiWhisperProvider
    case 'deepgram':
      return deepgramProvider
    case 'builtin':
      return builtinAsrProvider
    default:
      return undefined
  }
}
