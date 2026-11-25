import type { AppSettings, TranscriptSegment } from '../types'
import type { AsrProvider } from './types'

/**
 * DeepSeek ASR 适配器（全家桶 /v1/tools/asr，2026-05 全量开放）。
 *
 * 官方限制与特点：
 *  - 单次请求 ≤120 秒、≤8 MiB，整段上传、不支持流式；
 *  - 只收 16 位 PCM WAV 或 Ogg Opus；录音产物是 webm/opus，要先解码重采样；
 *  - 返回整段文本（{ text, duration_ms }），没有时间戳、没有说话人分离；
 *    这里按固定片长切分，每片一条 segment，时间轴按片偏移对齐。
 *
 * 定价 ≈0.39 元/小时，中文场景性价比高；但会议需要说话人区分时，
 * 建议用 MiniMax（自带 diarization）或本机内置引擎。
 */
export const deepseekProvider: AsrProvider = {
  id: 'deepseek',
  transcribe: async ({ blob, settings }) => {
    const key = settings.asr_api_key?.trim()
    if (!key) throw new Error('DeepSeek API Key 未填写 —— 到「设置 → 语音识别」粘贴。')
    const base = (settings.asr_base_url || 'https://api.deepseek.com').replace(/\/+$/, '')

    // 解码 → 16k 单声道（DeepSeek 不限采样率，但 16k 足够、体积小）
    const pcm = await decodeTo16kMono(blob)
    const SR = 16_000
    const CHUNK_SEC = 60 // 每片 60s：进度颗粒度与请求数的折中
    const chunks: Float32Array[] = []
    for (let off = 0; off < pcm.length; off += CHUNK_SEC * SR) {
      chunks.push(pcm.subarray(off, Math.min(pcm.length, off + CHUNK_SEC * SR)))
    }

    const segments: TranscriptSegment[] = []
    for (let i = 0; i < chunks.length; i++) {
      const wav = encodeWav16(chunks[i], SR)
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), `chunk-${i + 1}.wav`)
      const res = await fetch(`${base}/v1/tools/asr`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(
          `DeepSeek ASR 失败（第 ${i + 1}/${chunks.length} 片，HTTP ${res.status}）：${text.slice(0, 200)}`,
        )
      }
      const json = JSON.parse(text) as { text?: string; duration_ms?: number }
      const segText = (json.text ?? '').trim()
      if (!segText) continue
      const startMs = i * CHUNK_SEC * 1000
      const durMs = typeof json.duration_ms === 'number' && json.duration_ms > 0
        ? json.duration_ms
        : chunks[i].length / SR * 1000
      // DeepSeek 无说话人分离：置空（UI 会回退成「发言」），不虚构「说话人 1」
      segments.push({
        start_ms: startMs,
        end_ms: startMs + Math.round(durMs),
        speaker_label: '',
        text: segText,
      })
    }
    if (segments.length === 0) {
      throw new Error('DeepSeek ASR 返回空文本——检查音频内容，或换一个供应商重试。')
    }
    return segments
  },
}

/** 浏览器解码（webm/opus → AudioBuffer）→ 重采样 16k 单声道 */
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

/** Float32 单声道 → 16 位 PCM WAV（DeepSeek 只认 WAV / Ogg Opus） */
function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataSize = samples.length * 2
  const buf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buf)
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)          // PCM 块大小
  v.setUint16(20, 1, true)           // PCM 编码
  v.setUint16(22, 1, true)           // 单声道
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // 字节率
  v.setUint16(32, 2, true)           // 块对齐
  v.setUint16(34, 16, true)          // 位深
  writeStr(36, 'data')
  v.setUint32(40, dataSize, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s * 0x7fff, true)
  }
  return buf
}
