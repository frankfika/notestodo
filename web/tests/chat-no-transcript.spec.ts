/**
 * ChatPanel 无转录 fallback e2e — meeting 已 transcribed 但 transcripts 表空
 * （pipeline 失败或用户清了），或 transcribing/summarizing 阶段
 *
 * ChatPanel 应能正常用 — system prompt 包含「(无转录)」fallback
 * 不会因为 transcript 缺失报错
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('ChatPanel：meeting 无 transcript 时不报错', async ({ page }) => {
  test.setTimeout(30_000)

  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: '我看不到转录但可以猜' }], model: 'm', stop_reason: 'end_turn' }),
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

  // Seed：meeting 没有 transcript
  const meetingId = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'kv'], 'readwrite')
        tx.objectStore('kv').put({
          key: 'settings',
          value: { theme: 'dark', llm_provider: 'anthropic-compatible', llm_base_url: 'http://x', llm_api_key: 'sk', llm_model: 'm', asr_provider: 'minimax', asr_base_url: 'http://x', asr_api_key: 'sk', asr_model: 'm', language: 'zh' },
        })
        tx.objectStore('meetings').put({
          id, title: '无转录会议', status: 'summarized',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 30_000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
          source: 'manual',
        })
        // 关键：无 transcript 行
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

  // 打开 chat
  await page.getByRole('button', { name: '对话' }).click()
  await page.waitForTimeout(500)

  // 发问
  await page.locator('textarea').fill('随便聊聊')
  await page.locator('textarea').press('Enter')
  await page.waitForTimeout(1500)

  // 1) AI 回复出现（mock 不依赖 transcript）
  await expect(page.getByText('我看不到转录但可以猜')).toBeAttached({ timeout: 5_000 })

  // 2) 没有 err 红字
  const errCount = await page.locator('text=转录失败').count()
  expect(errCount).toBe(0)

  // 3) DB 中有 2 条 chat message（user + assistant）
  const dbCount = await page.evaluate(async (id) => new Promise<number>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['chatMessages'], 'readonly')
      const all = tx.objectStore('chatMessages').getAll()
      all.onsuccess = () => res((all.result as Array<{ meeting_id: string }>).filter((m) => m.meeting_id === id).length)
      setTimeout(() => rej(new Error('timeout')), 5_000)
    }
  }), meetingId)
  expect(dbCount).toBe(2)
})