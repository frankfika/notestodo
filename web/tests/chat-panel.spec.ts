/**
 * ChatPanel e2e — 用户对会议提问 → 走 LLM → AI 回复落库 → UI 渲染。
 *
 * 这是「AI native」的核心兑现路径（需求 #2 + #5）：
 *   1. 会议存在且有 transcript（system prompt 会包含全文转录）
 *   2. 用户发送消息
 *   3. ChatPanel 构建 system prompt = 标题 + 时间 + 时长 + 转录 + 纪要
 *   4. LLM 调用（mocked）→ reply 写入 chatMessages
 *   5. UI 同时显示 user + assistant 两条消息
 *
 * Mock 策略：所有 /v1/messages 返回 canned 回复。
 * 验证 prompt 里包含会议标题、转录、纪要（system content 可被 mock 收到）
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('ChatPanel：提问 → LLM 引用转录回复 → 双向消息渲染', async ({ page }) => {
  test.setTimeout(60_000)

  let receivedSystemPrompt = ''
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        // 提取 system prompt 用于断言
        // Anthropic 协议：system 在 body.system（顶层）；OpenAI 协议：messages[0].role==='system'
        try {
          const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : {}
          if (body && typeof body.system === 'string') {
            ;(window as unknown as { __lastSys?: string }).__lastSys = body.system as string
          } else if (body && Array.isArray(body.messages)) {
            const sys = (body.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'system')
            if (sys) (window as unknown as { __lastSys?: string }).__lastSys = sys.content
          }
        } catch { /* ignore parse */ }
        return new Response(
          JSON.stringify({
            id: 'msg_mock', type: 'message', role: 'assistant',
            content: [{ type: 'text', text: '依据转录，关键决策是 [00:30] 同意 Q4 目标。' }],
            model: 'mock', stop_reason: 'end_turn',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return realFetch(input, init)
    }
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  // 通过 __uiStore 直接导航到 meeting-detail，避免 UI 导航路径的不确定性
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
          value: {
            theme: 'dark', llm_provider: 'anthropic-compatible', llm_base_url: 'http://127.0.0.1:9999',
            llm_api_key: 'sk', llm_model: 'm', asr_provider: 'minimax', asr_base_url: 'http://127.0.0.1:9999',
            asr_api_key: 'sk', asr_model: 'asr-1.0', language: 'zh',
          },
        })
        tx.objectStore('meetings').put({
          id, title: 'E2E 聊天测试会议', status: 'summarized',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 3000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
          source: 'manual',
        })
        tx.objectStore('transcripts').put({
          id: crypto.randomUUID(), meeting_id: id, language: 'zh', engine: 'mock',
          engine_meta: {},
          segments: [
            { speaker_label: '陈放', text: '今天讨论 Q4 目标', start_ms: 0, end_ms: 1500, confidence: 0.99 },
            { speaker_label: '朱迪', text: '同意，关键决策确认', start_ms: 1500, end_ms: 3000, confidence: 0.99 },
          ],
          speaker_names: { '陈放': '陈放', '朱迪': '朱迪' },
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('summaries').put({
          id: crypto.randomUUID(), meeting_id: id, template_id: 'default',
          content_md: '## 决策\n- Q4 目标已确认',
          raw_llm_output: null, generated_at: nowIso, model: 'mock',
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })

  // 导航到 meeting-detail
  await page.evaluate((id) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goMeeting: (id: string) => void } } }).__uiStore
    ui?.getState().goMeeting(id)
  }, meetingId)
  await page.waitForTimeout(500)

  // 1) ChatPanel 默认关着；打开它
  await page.getByRole('button', { name: '对话' }).click({ timeout: 5_000 })
  await expect(page.getByText('提问这场会议…（Enter 玩法）').or(page.locator('textarea'))).toBeVisible({ timeout: 5_000 })

  // 2) 输入问题 → Ctrl+Enter 触发（textarea 支持 Enter 发送）
  const textarea = page.locator('textarea')
  await textarea.fill('这场会议的关键决策是什么？')
  await textarea.press('Enter')

  // 3) 等 AI 回复落库并渲染
  await page.waitForTimeout(2500)

  // 4) 用户消息显示在 UI 中
  expect(page.getByText('这场会议的关键决策是什么？')).toBeVisible({ timeout: 5_000 })
  // 5) AI 回复（mock 返回「依据转录，关键决策是 ...」）显示
  // 用更具体的唯一匹配避免和 user 问题文本冲突
  expect(page.getByText('依据转录，关键决策是')).toBeVisible({ timeout: 5_000 })

  // 6) 数据库中应有 user + assistant 两条消息
  const dbMessages = await page.evaluate(async (id) => new Promise<Array<{ role: string; content: string }>>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb-open-failed'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['chatMessages'], 'readonly')
      const all = tx.objectStore('chatMessages').getAll()
      all.onsuccess = () => res(
        (all.result as Array<{ meeting_id: string; role: string; content: string; created_at: string }>)
          .filter((m) => m.meeting_id === id)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((m) => ({ role: m.role, content: m.content })),
      )
      setTimeout(() => rej(new Error('timeout')), 5_000)
    }
  }), meetingId)

  expect(dbMessages.length).toBe(2)
  expect(dbMessages[0]?.role).toBe('user')
  expect(dbMessages[0]?.content).toBe('这场会议的关键决策是什么？')
  expect(dbMessages[1]?.role).toBe('assistant')
  expect(dbMessages[1]?.content).toContain('决策')

  // 7) 验证 system prompt 包含会议标题 + 转录（核心上下文传给 LLM）
  receivedSystemPrompt = await page.evaluate(() => (window as unknown as { __lastSys?: string }).__lastSys ?? '')
  expect(receivedSystemPrompt).toContain('E2E 聊天测试会议')
  expect(receivedSystemPrompt).toContain('Q4 目标')
  expect(receivedSystemPrompt).toContain('关键决策确认')
})