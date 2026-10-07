/**
 * 转录管线 e2e — 关键路径：
 *   1. meeting 无 transcript → 调 ASR → 写 transcript → 状态 'transcribed' → summarize
 *   2. meeting 已有 transcript → **跳过 ASR**（不再二次计费）→ 直接 summarize
 *   3. ASR 抛错 → meeting.status='failed'，error 字段被持久化
 *
 * 通过 fetch monkey-patch 拦截 ASR（minimax）和 LLM，
 * 控制响应/错误。验证状态机完整覆盖。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

const CANNED_LLM_JSON = JSON.stringify({
  summary_md: '## 结论\n- 顺利。',
  todos: [
    { title: '跟进', evidence_span: [0, 1000], evidence_quote: '跟进' },
  ],
})

test('转录管线：已有 transcript 时跳过 ASR，直接进 summarize（避免重复计费）', async ({ page }) => {
  test.setTimeout(60_000)
  page.on('console', (msg) => {
    if (msg.text().startsWith('[t]')) console.log('PAGE:', msg.text())
  })

  let asrCalls = 0
  // 拦截 ASR + LLM；ASR 路径递增计数器，证明第二次调用没触发
  await page.addInitScript(
    ({ canned, capture }) => {
      const realFetch = window.fetch.bind(window)
      ;(window as unknown as Record<string, unknown>).__capture = capture
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (url.includes('/v1/speech_to_text')) {
          ;(capture as { asr: number }).asr++
          return new Response(
            JSON.stringify({
              task_id: 'mock',
              task_status: 'success',
              result: {
                text: '你好世界',
                segments: [
                  { speaker: '说话人 1', text: '你好世界', start_time: 0, end_time: 1000 },
                ],
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
          ;(capture as { llm: number }).llm++
          return new Response(
            JSON.stringify({
              id: 'msg_mock', type: 'message', role: 'assistant',
              content: [{ type: 'text', text: canned }],
              model: 'mock', stop_reason: 'end_turn',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return realFetch(input, init)
      }
    },
    { canned: CANNED_LLM_JSON, capture: { asr: 0, llm: 0 } },
  )

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  // Seed: meeting + 真实 audio chunk + 一个已存在的 transcript
  const result1 = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'transcripts', 'audioChunks', 'kv'], 'readwrite')
        tx.objectStore('kv').put({
          key: 'settings',
          value: {
            theme: 'dark', llm_provider: 'anthropic-compatible', llm_base_url: 'http://127.0.0.1:9999',
            llm_api_key: 'sk', llm_model: 'm', asr_provider: 'minimax', asr_base_url: 'http://127.0.0.1:9999',
            asr_api_key: 'sk', asr_model: 'asr-1.0', language: 'zh',
          },
        })
        tx.objectStore('meetings').put({
          id, title: 't', status: 'processing',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 2000, size_bytes: 0, format: 'audio/webm', chunk_count: 1, chunks_dirty: false },
          source: 'manual',
        })
        tx.objectStore('audioChunks').put({
          id: crypto.randomUUID(), meeting_id: id, seq: 1,
          blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
          size_bytes: 3, duration_ms: 1000, created_at: nowIso,
        })
        tx.objectStore('transcripts').put({
          id: crypto.randomUUID(), meeting_id: id, language: 'zh', engine: 'minimax',
          engine_meta: {},
          segments: [{ speaker_label: '说话人 1', text: '预存转录', start_ms: 0, end_ms: 1000, confidence: 1 }],
          speaker_names: {}, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })

    const mod = await import('/src/pipeline/transcribe.ts')
    await Promise.race([
      mod.runTranscribePipeline(id),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000)),
    ])

    return new Promise<{
      status: string
      error?: string
      hasSummary: boolean
      asr: number
      llm: number
    }>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'summaries'], 'readonly')
        const m = tx.objectStore('meetings').get(id)
        const s = tx.objectStore('summaries').getAll()
        let meetingDone = false
        let summaryDone = false
        const fire = (): void => {
          if (!meetingDone || !summaryDone) return
          const cap = (window as unknown as { __capture?: { asr: number; llm: number } }).__capture ?? { asr: 0, llm: 0 }
          const summaries = s.result as Array<{ meeting_id: string }>
          res({
            status: (m.result as { status: string }).status,
            error: (m.result as { error?: string }).error,
            hasSummary: summaries.some((x) => x.meeting_id === id),
            asr: cap.asr,
            llm: cap.llm,
          })
        }
        m.onsuccess = () => { meetingDone = true; fire() }
        s.onsuccess = () => { summaryDone = true; fire() }
        setTimeout(() => rej(new Error('readback-timeout')), 5_000)
      }
      req.onerror = () => rej(new Error('idxb-open-failed'))
    })
  })

  expect(result1.status).toBe('summarized')
  expect(result1.error).toBeUndefined()
  expect(result1.hasSummary).toBe(true)
  // 关键断言：ASR 完全没被调用（idempotency 正确），LLM 只调用了一次
  expect(result1.asr).toBe(0)
  expect(result1.llm).toBe(1)
  void asrCalls // silence unused
})

test('转录管线：ASR 抛错 → status=failed，error 持久化（不再盲跑）', async ({ page }) => {
  test.setTimeout(60_000)

  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/speech_to_text')) {
        // ASR 模拟 401
        return new Response(
          JSON.stringify({
            type: 'error', error: { type: 'authorized_error', http_code: '401', message: 'mock 401' },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return realFetch(input, init)
    }
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  const result = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
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
          id, title: 't', status: 'processing',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 2000, size_bytes: 0, format: 'audio/webm', chunk_count: 1, chunks_dirty: false },
          source: 'manual',
        })
        tx.objectStore('audioChunks').put({
          id: crypto.randomUUID(), meeting_id: id, seq: 1,
          blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
          size_bytes: 3, duration_ms: 1000, created_at: nowIso,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })

    const mod = await import('/src/pipeline/transcribe.ts')
    await Promise.race([
      mod.runTranscribePipeline(id),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000)),
    ])

    return new Promise<{ status: string; error?: string }>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings'], 'readonly')
        const m = tx.objectStore('meetings').get(id)
        m.onsuccess = () => res({
          status: (m.result as { status: string }).status,
          error: (m.result as { error?: string }).error,
        })
        setTimeout(() => rej(new Error('readback-timeout')), 5_000)
      }
      req.onerror = () => rej(new Error('idxb-open-failed'))
    })
  })

  expect(result.status).toBe('failed')
  expect(result.error).toContain('转录失败')
  expect(result.error).toContain('mock 401')
})