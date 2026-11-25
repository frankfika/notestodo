/**
 * DeepSeek ASR 适配器单测（mock fetch，不走真实网络）：
 *  - 按 60s 片长切分长音频，逐片 POST /v1/tools/asr
 *  - 每片产出一条 segment，start_ms 按片偏移对齐
 *  - speaker_label 置空（DeepSeek 无说话人分离，UI 回退「发言」）
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

/** 生成 n 秒 16k 单声道 WAV（静音） */
function silentWavBytes(sec: number): Uint8Array {
  const sr = 16_000
  const n = sr * sec
  const dataSize = n * 2
  const buf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(buf)
  const w = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); w(8, 'WAVE')
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  w(36, 'data'); v.setUint32(40, dataSize, true)
  return new Uint8Array(buf)
}

test('DeepSeek ASR：125s 音频切成 3 片，时间轴对齐', async ({ page }) => {
  await page.goto(BASE)
  const result = await page.evaluate(async () => {
    const calls: string[] = []
    const realFetch = window.fetch.bind(window)
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/v1/tools/asr')) {
        calls.push(url)
        const i = calls.length
        return new Response(JSON.stringify({ request_id: `r${i}`, text: `第${i}片文字。`, duration_ms: 59000 }), { status: 200 })
      }
      return realFetch(input, init)
    }) as typeof window.fetch

    const { deepseekProvider } = await import('/src/transcribe/deepseek.ts')
    const { DEFAULT_SETTINGS } = await import('/src/types.ts')
    // 125 秒静音（WAV 头由测试侧生成，适配器内部还会走一遍 decodeAudioData）
    const sr = 16_000
    const n = sr * 125
    const dataSize = n * 2
    const buf = new ArrayBuffer(44 + dataSize)
    const v = new DataView(buf)
    const w = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); w(8, 'WAVE')
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
    w(36, 'data'); v.setUint32(40, dataSize, true)

    const segments = await deepseekProvider.transcribe({
      blob: new Blob([buf], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
      durationMs: 125_000,
      settings: { ...DEFAULT_SETTINGS, asr_api_key: 'sk-test', asr_base_url: 'https://api.deepseek.com' },
    })
    return { calls, segments: segments.map((s) => ({ start: s.start_ms, end: s.end_ms, speaker: s.speaker_label, text: s.text })) }
  })

  console.log(JSON.stringify(result, null, 1))
  expect(result.calls.length).toBe(3)
  expect(result.segments[0].start).toBe(0)
  expect(result.segments[1].start).toBe(60_000)
  expect(result.segments[2].start).toBe(120_000)
  expect(result.segments.map((s) => s.speaker)).toEqual(['', '', ''])
  expect(result.segments.map((s) => s.text).join('')).toContain('第1片')
})

test('DeepSeek ASR：注册表能按 settings 解析到适配器', async ({ page }) => {
  await page.goto(BASE)
  const id = await page.evaluate(async () => {
    const { getAsrProvider } = await import('/src/transcribe/types.ts')
    const { DEFAULT_SETTINGS } = await import('/src/types.ts')
    return getAsrProvider({ ...DEFAULT_SETTINGS, asr_mode: 'cloud', asr_provider: 'deepseek' })?.id
  })
  expect(id).toBe('deepseek')
})
