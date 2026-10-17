import { DIAR_IDS, catalogById, isReady, mockEnabled } from '../lib/builtinModels'
import { isTauri } from '../lib/tauri'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { requireModel } from '../llm/builtin'
import { resolveASRConfig, type TranscriptSegment } from '../types'
import type { AsrProvider } from './types'

/**
 * 应用内置 whisper.cpp 转录。前端把录音解码成 16kHz 单声道 PCM（WebAudio，webm/mp4 都能解），
 * 交给 Rust 命令 builtin_asr_transcribe；音频全程不出本机。
 */
export const builtinAsrProvider: AsrProvider = {
  id: 'builtin',
  transcribe: async ({ blob, settings, hotwords }) => {
    const m = requireModel(resolveASRConfig(settings).model)
    if (!isTauri() && mockEnabled()) return mockSegments()
    const pcm = await decodeTo16kMono(blob)
    // raw IPC：请求体直接是 i16 LE 字节（1 小时约 115MB），不走 JSON
    const i16 = new Int16Array(pcm.length)
    for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-1, Math.min(1, pcm[i])) * 0x7fff
    return tauriInvoke<TranscriptSegment[]>('builtin_asr_transcribe', new Uint8Array(i16.buffer), {
      // 请求头只能是 ASCII：热词 encodeURIComponent，Rust 端解码
      headers: {
        'x-model-file': m.file, 'x-language': 'zh', 'x-hotwords': encodeURIComponent((hotwords ?? []).join('\n')),
        // 说话人区分：两个模型都已下载才带上（否则只转录，不区分说话人）
        ...(DIAR_IDS.every(isReady) ? { 'x-diar-seg': catalogById(DIAR_IDS[0])!.file, 'x-diar-emb': catalogById(DIAR_IDS[1])!.file } : {}),
      },
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
