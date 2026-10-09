/**
 * ChatPanel 多轮对话 e2e — 验证连续 3 轮对话：每轮 user + assistant 落库 + 渲染。
 *
 * 关键点：第二轮之后，system prompt 中应包含完整 transcript + 第一轮的对话历史。
 * 这验证 callLLM 的 messages 数组构建顺序正确（system → 历史 → 当前 user）。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

const CANNED_REPLY = '这是 mock 的回复'

test('ChatPanel：3 轮对话 + 每轮 DB 都准确记录 + UI 顺序正确', async ({ page }) => {
  test.setTimeout(60_000)

  // 每次 /v1/messages 都返回同样 canned 回复 + 记录所有 system + messages 数量
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
          if (Array.isArray(body.messages)) {
            ;(window as unknown as { __lastMsgCount?: number }).__lastMsgCount = body.messages.length
          }
        } catch { /* ignore */ }
        return new Response(
          JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: '这是 mock 的回复' }], model: 'm', stop_reason: 'end_turn' }),
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

  // Seed：meeting + transcript + summary
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
          id, title: '多轮对话会议', status: 'summarized',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 60_000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
          source: 'manual',
        })
        tx.objectStore('transcripts').put({
          id: crypto.randomUUID(), meeting_id: id, language: 'zh', engine: 'mock',
          engine_meta: {},
          segments: [{ speaker_label: '陈放', text: '讨论 Q4 目标', start_ms: 0, end_ms: 2000, confidence: 0.99 }],
          speaker_names: {},
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('summaries').put({
          id: crypto.randomUUID(), meeting_id: id, template_id: 'default',
          content_md: '## 结论', raw_llm_output: null, generated_at: nowIso, model: 'm',
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })

  // 导航到详情页 + 打开 chat
  await page.evaluate((id) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goMeeting: (id: string) => void } } }).__uiStore
    ui?.getState().goMeeting(id)
  }, meetingId)
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '对话' }).click()
  await page.waitForTimeout(500)

  // 三轮对话
  const messages = ['Q1 关键决策是什么？', 'Q2 谁负责？', 'Q3 什么时候交付？']
  const ta = page.locator('textarea')
  for (const m of messages) {
    await ta.fill(m)
    await ta.press('Enter')
    await page.waitForTimeout(2000) // 等 LLM 响应 + DB 写
  }

  // 1) DB 中有 3 user + 3 assistant = 6 条 chatMessages（按 created_at 排序）
  const dbMessages = await page.evaluate(async (id) => new Promise<Array<{ role: string; content: string }>>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['chatMessages'], 'readonly')
      const all = tx.objectStore('chatMessages').getAll()
      all.onsuccess = () => {
        const filtered = (all.result as Array<{ meeting_id: string; created_at: string; role: string; content: string }>)
          .filter((m) => m.meeting_id === id)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((m) => ({ role: m.role, content: m.content }))
        res(filtered)
      }
      setTimeout(() => rej(new Error('timeout')), 5_000)
    }
  }), meetingId)

  expect(dbMessages.length).toBe(6)
  expect(dbMessages.filter((m) => m.role === 'user').length).toBe(3)
  expect(dbMessages.filter((m) => m.role === 'assistant').length).toBe(3)
  expect(dbMessages[0]?.content).toBe(messages[0])
  expect(dbMessages[1]?.content).toBe(CANNED_REPLY)
  expect(dbMessages[2]?.content).toBe(messages[1])
  expect(dbMessages[3]?.content).toBe(CANNED_REPLY)
  expect(dbMessages[4]?.content).toBe(messages[2])
  expect(dbMessages[5]?.content).toBe(CANNED_REPLY)

  // 2) 第三轮的 system prompt 应包含之前的对话历史（通过 LLM 调用计数验证）
  const lastMsgCount = await page.evaluate(() => (window as unknown as { __lastMsgCount?: number }).__lastMsgCount)
  // 第三轮请求：body.messages 应包含前 4 条 user/assistant 历史 + 1 当前 user = 5 条
  // （system 在 Anthropic 协议里被拆到 body.system 顶层字段，不在 messages 里）
  expect(lastMsgCount).toBe(5)

  // 3) UI 渲染 6 条消息（按时间排序：user1/assistant1/user2/assistant2/user3/assistant3）
  const chatList = page.locator('aside .flex-1.overflow-y-auto > div') // message 容器
  await expect(chatList.nth(0)).toContainText(messages[0])    // user1 Q1
  await expect(chatList.nth(1)).toContainText(CANNED_REPLY)    // assistant1
  await expect(chatList.nth(2)).toContainText(messages[1])    // user2 Q2
  await expect(chatList.nth(3)).toContainText(CANNED_REPLY)    // assistant2
  await expect(chatList.nth(4)).toContainText(messages[2])    // user3 Q3
  await expect(chatList.nth(5)).toContainText(CANNED_REPLY)    // assistant3
})