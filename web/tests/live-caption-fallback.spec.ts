/**
 * 实时字幕兜底：ASR 失败（或没配 Key）时，用会中实时字幕（kv live_caption_<id>）作为转录，
 * 会议不再直接 failed，笔记照样能整理。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

for (const asrKey of ['sk', ''] as const) {
  test(`实时字幕兜底转录（${asrKey ? 'ASR 401' : '未配 ASR Key'}）`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window)
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (url.includes('/v1/speech_to_text')) return new Response('{"error":"mock 401"}', { status: 401 })
        return realFetch(input, init)
      }
    })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)

    const result = await page.evaluate(async (asrKey) => {
      const id = crypto.randomUUID()
      const nowIso = new Date().toISOString()
      await new Promise<void>((res, rej) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const tx = req.result.transaction(['meetings', 'audioChunks', 'kv'], 'readwrite')
          tx.objectStore('kv').put({
            key: 'settings',
            value: {
              theme: 'light', llm_provider: 'anthropic-compatible', llm_base_url: 'http://127.0.0.1:9999',
              llm_api_key: '', llm_model: 'm', asr_provider: 'minimax', asr_base_url: 'http://127.0.0.1:9999',
              asr_api_key: asrKey, asr_model: 'asr-1.0',
            },
          })
          tx.objectStore('kv').put({
            key: `live_caption_${id}`,
            value: [
              { start_ms: 0, end_ms: 1500, speaker_label: '字幕', text: '方案B我们倾向推进' },
              { start_ms: 1600, end_ms: 3000, speaker_label: '字幕', text: '张三周五前把方案发出来' },
            ],
          })
          tx.objectStore('meetings').put({
            id, title: 't', status: 'processing',
            started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
            audio: { duration_ms: 3000, size_bytes: 0, format: 'audio/webm', chunk_count: 1, chunks_dirty: false },
            source: 'manual',
          })
          tx.objectStore('audioChunks').put({
            id: crypto.randomUUID(), meeting_id: id, seq: 1,
            blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
            size_bytes: 3, duration_ms: 3000, created_at: nowIso,
          })
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        }
      })

      const mod = await import('/src/pipeline/transcribe.ts')
      await mod.runTranscribePipeline(id).catch(() => undefined)

      return new Promise<{ engine?: string; texts: string[]; reason?: unknown }>((res) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const idx = req.result.transaction('transcripts').objectStore('transcripts').index('meeting_id').get(id)
          idx.onsuccess = () => {
            const t = idx.result as { engine: string; segments: { text: string }[]; engine_meta?: { fallback_reason?: unknown } } | undefined
            res({ engine: t?.engine, texts: t?.segments.map((s) => s.text) ?? [], reason: t?.engine_meta?.fallback_reason })
          }
        }
      })
    }, asrKey)

    expect(result.engine).toBe('live-caption')
    expect(result.texts).toEqual(['方案B我们倾向推进', '张三周五前把方案发出来'])
    expect(String(result.reason)).toContain(asrKey ? '401' : '未配置 ASR API Key')
  })
}
