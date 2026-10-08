/**
 * 启动时任务恢复 e2e — 用户最痛的失败路径：浏览器崩溃/强制重启后能否自动接续。
 *
 * 场景：
 *   1. 上次会话有 meeting 停在 processing/transcribed/summarizing 状态
 *   2. 用户重新打开 → resumePendingJobs() 自动跑对应管线
 *   3. meeting 最终到 summarizing 后的下一步（summarized 或 failed），无需手动操作
 *
 * 这个路径未测试过 — 若有 bug，等于用户一次录音转录丢了。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

const CANNED_LLM_JSON = JSON.stringify({
  summary_md: '恢复后生成的纪要。',
  todos: [{ title: '恢复任务', evidence_span: [0, 500], evidence_quote: '恢复' }],
})

test('启动恢复：上次卡在 processing 的会议被自动接续到 summarized', async ({ page }) => {
  test.setTimeout(60_000)

  // 拦截 LLM + ASR
  await page.addInitScript((canned) => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/speech_to_text')) {
        return new Response(
          JSON.stringify({
            task_id: 'm', task_status: 'success',
            result: { text: '恢复后的转录文本', segments: [{ speaker: 'A', text: '恢复后的转录文本', start_time: 0, end_time: 1000 }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: canned }], model: 'm', stop_reason: 'end_turn' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return realFetch(input, init)
    }
  }, CANNED_LLM_JSON)

  // 先开一个 page，注入卡住的 meeting + 设置 KV，然后关掉这个 page
  const ctx = await page.context().browser()!.newContext()
  const setupPage = await ctx.newPage()
  await setupPage.goto(BASE, { waitUntil: 'domcontentloaded' })
  await setupPage.waitForTimeout(500)

  const meetingId = await setupPage.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    const oldTime = new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 分钟前 — 触发 stale 阈值
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'audioChunks', 'kv'], 'readwrite')
        tx.objectStore('kv').put({
          key: 'settings',
          value: {
            theme: 'dark', llm_provider: 'anthropic-compatible', llm_base_url: 'http://127.0.0.1:9999',
            llm_api_key: 'sk', llm_model: 'm', asr_provider: 'minimax', asr_base_url: 'http://127.0.0.1:9999',
            asr_api_key: 'sk', asr_model: 'asr-1.0', language: 'zh',
          },
        })
        tx.objectStore('meetings').put({
          id, title: '崩溃时未完成的会议', status: 'processing',
          started_at: oldTime, ended_at: oldTime, updated_at: oldTime, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 1000, size_bytes: 0, format: 'audio/webm', chunk_count: 1, chunks_dirty: false },
          source: 'manual',
        })
        tx.objectStore('audioChunks').put({
          id: crypto.randomUUID(), meeting_id: id, seq: 1,
          blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
          size_bytes: 3, duration_ms: 1000, created_at: oldTime,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })
  await setupPage.close()

  // 现在打开一个新 page — 模拟「重启浏览器」；resumePendingJobs 应自动跑
  const fresh = await ctx.newPage()
  await fresh.addInitScript((canned) => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/speech_to_text')) {
        return new Response(JSON.stringify({ task_id: 'm', task_status: 'success', result: { text: '恢复后的转录文本', segments: [{ speaker: 'A', text: '恢复后的转录文本', start_time: 0, end_time: 1000 }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: canned }], model: 'm', stop_reason: 'end_turn' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return realFetch(input, init)
    }
  }, CANNED_LLM_JSON)
  await fresh.goto(BASE, { waitUntil: 'domcontentloaded' })
  // resume + 流处理日志: 给 8s 时间窗口（STAGGER_MS=2s + ASR/LLM 调用）
  await fresh.waitForTimeout(12_000)

  // 断言：meeting 状态已变为 summarized（pipeline 完整跑完）
  const finalState = await fresh.evaluate(async (id) => new Promise<{
    status: string
    hasTranscript: boolean
    hasSummary: boolean
    todoCount: number
  }>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['meetings', 'transcripts', 'summaries', 'todos'], 'readonly')
      const m = tx.objectStore('meetings').get(id)
      const tr = tx.objectStore('transcripts').getAll()
      const su = tx.objectStore('summaries').getAll()
      const t = tx.objectStore('todos').getAll()
      let done = 0
      let meetingR: { status: string } | undefined
      const check = (): void => {
        if (done < 4) return
        res({
          status: meetingR?.status ?? 'unknown',
          hasTranscript: (tr.result as Array<{ meeting_id: string }>).some((x) => x.meeting_id === id),
          hasSummary: (su.result as Array<{ meeting_id: string }>).some((x) => x.meeting_id === id),
          todoCount: (t.result as Array<{ meeting_id?: string }>).filter((x) => x.meeting_id === id).length,
        })
      }
      m.onsuccess = () => { meetingR = m.result as { status: string }; done++; check() }
      tr.onsuccess = () => { done++; check() }
      su.onsuccess = () => { done++; check() }
      t.onsuccess = () => { done++; check() }
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }), meetingId)

  expect(finalState.status).toBe('summarized')
  expect(finalState.hasTranscript).toBe(true)
  expect(finalState.hasSummary).toBe(true)
  expect(finalState.todoCount).toBe(1)

  await fresh.close()
  await ctx.close()
})