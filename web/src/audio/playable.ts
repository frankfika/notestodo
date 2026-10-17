/**
 * 让任何录音都能在当前 WebView 里回放。
 * 桌面版（macOS WKWebView / Safari）能录 WebM，却不一定能用 <audio> 播 WebM blob（实测转圈、时长 --:--）；
 * 但 WebAudio 能解码它（转录就是这么做的）。所以：能直接播就直接播，不能就解码后转成 WAV 再播。
 */

/** 浏览器能否直接播放这种 MIME（canPlayType 返回 '' 表示不能） */
export function canPlayNatively(mime: string): boolean {
  if (typeof document === 'undefined') return false
  return document.createElement('audio').canPlayType(mime.split(';')[0]) !== ''
}

/** 解码任意可解码音频 → 单声道 PCM16 WAV（默认 24kHz：语音足够清楚，1 小时约 170MB 内存峰值前已足够小） */
export async function toWav(blob: Blob, sampleRate = 24_000): Promise<Blob> {
  const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer())
  const frames = Math.max(1, Math.ceil(decoded.duration * sampleRate))
  const off = new OfflineAudioContext(1, frames, sampleRate)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  return encodeWav((await off.startRendering()).getChannelData(0), sampleRate)
}

export function encodeWav(pcm: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true)
  return new Blob([buf], { type: 'audio/wav' })
}

/** WebKit（Safari / macOS WKWebView）：优先录 MP4/AAC —— 原生能录也能播 */
export function isWebKit(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg|OPR)\//.test(ua)
}
