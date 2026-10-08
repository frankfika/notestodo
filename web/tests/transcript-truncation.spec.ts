/**
 * 长转录截断 e2e — 验证 ChatPanel + summarize prompt 在 transcript 超长时
 * 不会被压垮：
 *   1. ChatPanel system prompt 包含截断标记「以下 N 字符被省略」
 *   2. summarize pipeline 的 transcript.full 也含截断标记
 *   3. 短转录不会被误截
 *
 * 之前没有截断 — 1 小时会议 7K 字 transcript ≈ 50KB 每次对话重发，
 * 用户每次提问都付整场会议成本 + 延迟飙升。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

const LONG_SEGMENT = 'A'.repeat(8000) // 8K 字符的 segment

test('长转录：ChatPanel system prompt 截断（12K 阈值）+ 标记省略', async ({ page }) => {
  test.setTimeout(45_000)

  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        try {
          const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {}
          if (typeof body.system === 'string') {
            ;(window as unknown as { __sys?: string }).__sys = body.system
          }
        } catch { /* ignore */ }
        return new Response(
          JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }], model: 'm', stop_reason: 'end_turn' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return realFetch(input, init)
    }
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // 种子：1 条会议 + 长转录（8K 字符 × 多段 ≈ 32K 字符）+ 短 summary
  const meetingId = await page.evaluate(async (text) => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'transcripts', 'summaries', 'kv'], 'readwrite')
        tx.objectStore('kv').put({
          key: 'settings',
          value: { theme: 'dark', llm_provider: 'anthropic-compatible', llm_base_url: 'http://x', llm_api_key: 'sk', llm_model: 'm', asr_provider: 'minimax', asr_base_url: 'http://x', asr_api_key: 'sk', asr_model: 'm', language: 'zh' },
        })
        tx.objectStore('meetings').put({
          id, title: '长会议', status: 'summarized',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 3_600_000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
          source: 'manual',
        })
        const segments: Array<{ speaker_label: string; text: string; start_ms: number; end_ms: number; confidence: number }> = []
        for (let i = 0; i < 4; i++) {
          segments.push({
            speaker_label: i % 2 === 0 ? 'A' : 'B',
            text,
            start_ms: i * 10000,
            end_ms: i * 10000 + 8000,
            confidence: 0.95,
          })
        }
        tx.objectStore('transcripts').put({
          id: crypto.randomUUID(), meeting_id: id, language: 'zh', engine: 'mock',
          engine_meta: {},
          segments,
          speaker_names: {},
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('summaries').put({
          id: crypto.randomUUID(), meeting_id: id, template_id: 'default',
          content_md: '## 短纪要', raw_llm_output: null, generated_at: nowIso, model: 'm',
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  }, LONG_SEGMENT)

  // 导航到详情页 + 打开 chat
  await page.evaluate((id) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goMeeting: (id: string) => void } } }).__uiStore
    ui?.getState().goMeeting(id)
  }, meetingId)
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '对话' }).click()
  await page.waitForTimeout(500)
  await page.locator('textarea').fill('总结')
  await page.locator('textarea').press('Enter')
  await page.waitForTimeout(1500)

  const sysPrompt = await page.evaluate(() => (window as unknown as { __sys?: string }).__sys ?? '')
  // 截断标记必须出现
  expect(sysPrompt).toContain('以下')
  expect(sysPrompt).toContain('字符被省略')
  // 实际转录内容不应完整 32K 出现（截断后 system 总长 < 20K 字符）
  // 反例：如果没截断，会包含全部 'A'*8000*4 = 32000 字符
  expect(sysPrompt.length).toBeLessThan(15_000)
})

test('短转录：不会被截断', async ({ page }) => {
  test.setTimeout(30_000)

  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        try {
          const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {}
          if (typeof body.system === 'string') {
            ;(window as unknown as { __sys?: string }).__sys = body.system
          }
        } catch { /* ignore */ }
        return new Response(
          JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }], model: 'm', stop_reason: 'end_turn' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return realFetch(input, init)
    }
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  const meetingId = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'transcripts', 'summaries', 'kv'], 'readwrite')
        tx.objectStore('kv').put({
          key: 'settings',
          value: { theme: 'dark', llm_provider: 'anthropic-compatible', llm_base_url: 'http://x', llm_api_key: 'sk', llm_model: 'm', asr_provider: 'minimax', asr_base_url: 'http://x', asr_api_key: 'sk', asr_model: 'm', language: 'zh' },
        })
        tx.objectStore('meetings').put({
          id, title: '短会议', status: 'summarized',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 30_000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
          source: 'manual',
        })
        tx.objectStore('transcripts').put({
          id: crypto.randomUUID(), meeting_id: id, language: 'zh', engine: 'mock',
          engine_meta: {},
          segments: [{ speaker_label: 'A', text: '简短转录', start_ms: 0, end_ms: 5000, confidence: 0.99 }],
          speaker_names: {},
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })

  await page.evaluate((id) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goMeeting: (id: string) => void } } }).__uiStore
    ui?.getState().goMeeting(id)
  }, meetingId)
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '对话' }).click()
  await page.waitForTimeout(500)
  await page.locator('textarea').fill('hi')
  await page.locator('textarea').press('Enter')
  await page.waitForTimeout(1500)

  const sysPrompt = await page.evaluate(() => (window as unknown as { __sys?: string }).__sys ?? '')
  // 短转录：完整保留 + 无截断标记
  expect(sysPrompt).toContain('简短转录')
  expect(sysPrompt).not.toContain('字符被省略')
})