/**
 * ChatPanel 错误恢复 e2e — LLM 调用失败时用户消息仍持久化 + 错误展示
 *
 * 之前未覆盖：send() 内部 catch 块 — 用户消息先 add(成功) → 然后 LLM 失败 → 只 setErr
 * 不 add aiMsg。修复 bug 应该是：从 catch 中删除 userMsg（丢失用户输入）—— 但这是
 * 糟糕的 UX。
 *
 * 修复前 vs 后：catch 不删除 userMsg。已实现 + 测试覆盖。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('ChatPanel LLM 失败：用户消息保留 + 错误展示 + 不会丢失输入', async ({ page }) => {
  test.setTimeout(30_000)

  // LLM 调用始终失败
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream 502' } }),
          { status: 502, headers: { 'Content-Type': 'application/json' } },
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
        const tx = db.transaction(['meetings', 'kv'], 'readwrite')
        tx.objectStore('kv').put({
          key: 'settings',
          value: { theme: 'dark', llm_provider: 'anthropic-compatible', llm_base_url: 'http://x', llm_api_key: 'sk', llm_model: 'm', asr_provider: 'minimax', asr_base_url: 'http://x', asr_api_key: 'sk', asr_model: 'm', language: 'zh' },
        })
        tx.objectStore('meetings').put({
          id, title: '错误恢复测试', status: 'summarized',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 30_000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
          source: 'manual',
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
  await page.locator('textarea').fill('重要提问')
  await page.locator('textarea').press('Enter')
  await page.waitForTimeout(2000) // 等失败响应

  // 1) UI 显示用户消息（持久化的）
  await expect(page.getByText('重要提问')).toBeAttached({ timeout: 5_000 })

  // 2) UI 显示错误消息
  await expect(page.getByText(/upstream 502|api_error/)).toBeAttached({ timeout: 5_000 })

  // 3) 错误区域可见
  const errCount = await page.getByText(/upstream 502|api_error/).count()
  expect(errCount).toBeGreaterThanOrEqual(1)

  // 4) DB 中只有 1 条 user message（无 AI reply）
  const dbCount = await page.evaluate(async (id) => new Promise<{
    userCount: number
    assistantCount: number
  }>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['chatMessages'], 'readonly')
      const all = tx.objectStore('chatMessages').getAll()
      all.onsuccess = () => {
        const msgs = (all.result as Array<{ meeting_id: string; role: string }>).filter((m) => m.meeting_id === id)
        res({
          userCount: msgs.filter((m) => m.role === 'user').length,
          assistantCount: msgs.filter((m) => m.role === 'assistant').length,
        })
      }
      setTimeout(() => rej(new Error('timeout')), 5_000)
    }
  }), meetingId)
  expect(dbCount.userCount).toBe(1)
  expect(dbCount.assistantCount).toBe(0)

  // 5) busy 已释放（textarea 可继续输入）
  const isDisabled = await page.locator('textarea').isDisabled()
  expect(isDisabled).toBe(false)
})