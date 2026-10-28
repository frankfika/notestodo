/**
 * 生成「假麦克风」音频文件（供 Chromium --use-file-for-fake-audio-capture 使用）。
 *
 * 为什么需要它：Chromium 自带的 --use-fake-device-for-media-stream 音频源只在开头
 * 几秒有声，之后近乎静音 —— 录音电平条会趴平（宣传片要「电平可见」），
 * 而且会中页 5 秒静音提示（micSilent）可能被触发。
 *
 * 这里合成一段类人声的连续信号：180Hz 基频 + 谐波，按「音节」做包络调制，
 * 音节之间有极短停顿。RMS 稳定在 0.35 上下，电平条全程有明显幅度且持续起伏。
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const FAKE_MIC_WAV = path.join(__dirname, '..', 'assets', 'fake-mic.wav')

/**
 * 合成一段类人声的连续信号：180Hz 上下基频 + 谐波，按「音节」做包络调制。
 *
 * 关键约束（实测音频引擎：analyser fftSize 256 → 每 100ms 在约 5.3ms 窗口上算 RMS，
 * 再 ×2.5 作为电平）：包络不能落到 0，否则截图有概率落在静音瞬间，电平条趴平。
 * 这里把包络压到 0.55–1.0，实测电平稳定在 0.41–0.74 之间持续起伏 —— 既明显又在动。
 */
export function buildFakeMicWav({ seconds = 12, sampleRate = 48_000 } = {}) {
  const n = seconds * sampleRate
  const data = Buffer.alloc(n * 2)
  // 确定性伪随机（不引依赖，也不让每次采集的波形飘）
  let seed = 20261018
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

  let i = 0
  while (i < n) {
    // 音节之间不留空隙：包络自带 0.55 下限
    const sylLen = Math.round((0.11 + rnd() * 0.15) * sampleRate)
    // 实测音频引擎算出的 RMS 只有这里振幅的约 0.22 倍，故整体加 2.2 倍增益：
    // 电平稳定落在 0.1–1.0（均值约 0.55），电平条始终有幅度且在动。
    const peak = (0.55 + rnd() * 0.15) * 2.2
    const f0 = 150 + rnd() * 90
    for (let k = 0; k < sylLen && i < n; k++, i++) {
      const env = 0.55 + 0.45 * Math.sin((Math.PI * k) / sylLen) // 0.55 → 1.0 → 0.55
      const t = i / sampleRate
      const s = Math.sin(2 * Math.PI * f0 * t) * 0.62
        + Math.sin(2 * Math.PI * f0 * 2 * t) * 0.24
        + Math.sin(2 * Math.PI * f0 * 3 * t) * 0.14
      const v = Math.max(-1, Math.min(1, s * env * peak))
      data.writeInt16LE(Math.round(v * 32767), i * 2)
    }
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)

  return Buffer.concat([header, data])
}

export async function ensureFakeMicWav() {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path.dirname(FAKE_MIC_WAV), { recursive: true })
  await writeFile(FAKE_MIC_WAV, buildFakeMicWav())
  return FAKE_MIC_WAV
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = await ensureFakeMicWav()
  console.log('wrote', p)
}
