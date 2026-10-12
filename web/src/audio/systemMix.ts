import { onSystemAudioChunk, type SystemAudioChunk } from '../lib/tauriSystemAudio'

/**
 * Phase-4：把 Rust 端 `system_audio:chunk`（interleaved f32 PCM）实时喂进
 * AudioContext，与麦克风一起混进同一个 MediaStreamDestination，
 * MediaRecorder 录这个混合流 → 系统声音真正写入录音文件。
 *
 * 调度：每个 chunk 变成一个 AudioBuffer，按 `nextTime` 游标无缝排队；
 * 游标落后于 currentTime（事件抖动 / 主线程卡顿）则重置并留一点抖动缓冲。
 */

/** 抖动缓冲：游标重置时领先 currentTime 的秒数。 */
const JITTER_S = 0.08
/** 积压上限：游标领先超过该值说明消费不过来，丢弃该 chunk 防止延迟无限增长。 */
const MAX_LEAD_S = 1.0

export interface SystemMix {
  /** 系统声音输出节点，由调用方连到 destination / analyser。 */
  output: GainNode
  /** 已收到的 chunk 数（诊断 / 判断通道是否真在流）。 */
  readonly received: number
  stop: () => void
}

export async function startSystemMix(ctx: AudioContext): Promise<SystemMix> {
  const output = ctx.createGain()
  let nextTime = 0
  let received = 0
  let stopped = false

  const handle = (chunk: SystemAudioChunk): void => {
    if (stopped) return
    const ch = Math.max(1, chunk.channels | 0)
    const frames = Math.floor(chunk.samples.length / ch)
    if (frames <= 0) return
    received++

    const rate = chunk.sample_rate || 48000
    let buf: AudioBuffer
    try {
      buf = ctx.createBuffer(ch, frames, rate)
    } catch {
      return
    }
    for (let c = 0; c < ch; c++) {
      const data = buf.getChannelData(c)
      for (let i = 0; i < frames; i++) data[i] = chunk.samples[i * ch + c]
    }

    const t = ctx.currentTime
    if (nextTime < t) nextTime = t + JITTER_S
    else if (nextTime - t > MAX_LEAD_S) return

    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(output)
    src.onended = () => src.disconnect()
    src.start(nextTime)
    nextTime += buf.duration
  }

  const unlisten = await onSystemAudioChunk(handle)

  return {
    output,
    get received() {
      return received
    },
    stop: () => {
      stopped = true
      unlisten()
      try {
        output.disconnect()
      } catch {
        // ignore
      }
    },
  }
}
