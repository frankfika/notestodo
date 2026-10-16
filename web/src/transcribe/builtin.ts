import { mockEnabled } from '../lib/builtinModels'
import { isTauri } from '../lib/tauri'
import { invoke } from '../lib/tauriInvoke'
import { requireModel } from '../llm/builtin'
import { resolveASRConfig, type TranscriptSegment } from '../types'
import type { AsrProvider } from './types'

/**
 * 应用内置 whisper.cpp 转录。前端把录音解码成 16kHz 单声道 PCM（WebAudio，webm/mp4 都能解），
 * 交给 Rust 命令 builtin_asr_transcribe；音频全程不出本机。
 */
export const builtinAsrProvider: AsrProvider = {
  id: 'builtin',
  transcribe: async ({ blob, settings }) => {
    const m = requireModel(resolveASRConfig(settings).model)
    if (!isTauri() && mockEnabled()) return mockSegments()
    const pcm = await decodeTo16kMono(blob)
    // ponytail: 整段 PCM 走 JSON IPC（1 小时约 57M 浮点）；超长会议再改成分段 / 原始字节通道
    return invoke<TranscriptSegment[]>('builtin_asr_transcribe', {
      model: m.id, file: m.file, language: 'zh', pcm: Array.from(pcm),
    })
  },
}

async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer()
  const decoded = await new AudioContext().decodeAudioData(buf)
  const frames = Math.ceil(decoded.duration * 16_000)
  const off = new OfflineAudioContext(1, Math.max(1, frames), 16_000)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  return (await off.startRendering()).getChannelData(0)
}

async function mockSegments(): Promise<TranscriptSegment[]> {
  await new Promise((r) => setTimeout(r, 600))
  return [
    { start_ms: 0, end_ms: 4000, speaker_label: '说话人 1', text: '（模拟转录）我们先过一下本周进度。' },
    { start_ms: 4000, end_ms: 9000, speaker_label: '说话人 1', text: '（模拟转录）方案评审放到周五。' },
  ]
}
