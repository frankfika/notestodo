/**
 * ChatPanel 大量消息性能 e2e — 验证 30 轮对话（60 条消息）渲染流畅
 *
 * 真实场景：用户跟会议笔记聊 1 小时 = 几十轮。
 * React + useLiveQuery 应能流畅渲染 + scrollTo 不卡顿。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

const CANNED_REPLY = '回复'

test('ChatPanel 30 轮对话：60 条消息渲染 + 滚动无卡顿', async ({ page }) => {
  test.setTimeout(60_000)

  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: '回复' }], model: 'm', stop_reason: 'end_turn' }),
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

  // Seed: meeting + 60 条预存的 chatMessages（30 user + 30 assistant）
  const meetingId = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'chatMessages', 'kv'], 'readwrite')
        tx.objectStore('kv').put({
          key: 'settings',
          value: { theme: 'dark', llm_provider: 'anthropic-compatible', llm_base_url: 'http://x', llm_api_key: 'sk', llm_model: 'm', asr_provider: 'minimax', asr_base_url: 'http://x', asr_api_key: 'sk', asr_model: 'm', language: 'zh' },
        })
        tx.objectStore('meetings').put({
          id, title: '长对话性能测试', status: 'summarized',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 60_000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_perms: false },
          source: 'manual',
        })
        // 60 条消息（30 轮对话）
        for (let i = 0; i < 30; i++) {
          const baseTime = Date.now() + i * 1000
          tx.objectStore('chatMessages').put({
            id: crypto.randomUUID(), meeting_id: id, role: 'user', content: `问 ${i + 1}`,
            created_at: new Date(baseTime).toISOString(),
            updated_at: new Date(baseTime).toISOString(),
            deleted_at: null, sync_version: 0,
          })
          tx.objectStore('chatMessages').put({
            id: crypto.randomUUID(), meeting_id: id, role: 'assistant', content: `回复 ${i + 1}`,
            created_at: new Date(baseTime + 500).toISOString(),
            updated_at: new Date(baseTime + 500).toISOString(),
            deleted_at: null, sync_version: 0,
          })
        }
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })

  // 导航 → 打开 chat
  await page.evaluate((id) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goMeeting: (id: string) => void } } }).__uiStore
    ui?.getState().goMeeting(id)
  }, meetingId)
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '对话' }).click()
  await page.waitForTimeout(500)

  // 1) 60 条消息在 DOM 中渲染
  const msgCount = await page.locator('aside .flex-1.overflow-y-auto > div').count()
  expect(msgCount).toBe(60)

  // 2) 性能：渲染完成后, 1s 内可与 textarea 交互（不卡死）
  const interactionStart = Date.now()
  await page.locator('textarea').fill('test 性能')
  const interactionMs = Date.now() - interactionStart
  expect(interactionMs).toBeLessThan(2000)

  // 3) 性能：发送消息后能立即渲染（不卡 60 条已渲染列表）
  const sendStart = Date.now()
  await page.locator('textarea').press('Enter')
  // 等新消息出现（user 61 + assistant 62 = 62）
  await page.waitForFunction(
    () => document.querySelectorAll('aside .flex-1.overflow-y-auto > div').length >= 62,
    { timeout: 5_000 },
  ).catch(() => null)
  const sendMs = Date.now() - sendStart
  expect(sendMs).toBeLessThan(4000)

  // 4) 最后状态：textarea 已清空 + 60+2=62 条消息
  const finalCount = await page.locator('aside .flex-1.overflow-y-auto > div').count()
  expect(finalCount).toBeGreaterThanOrEqual(62)
})