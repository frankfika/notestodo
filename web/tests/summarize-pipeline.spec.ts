/**
 * 总结管线 e2e — 验证：转录 → LLM 总结 → todos 落库 → meeting.status='summarized'
 *
 * 通过 init script 在 LLM 客户端中替换 fetch 调用，直接在 ESM 模块内打 mock —
 * 避免 page.route 在 @playwright/test runner 内的环境差异带来的 hang。
 *
 * 这条管线从未被真实测试过 —— 是最大的未覆盖风险：
 *   - 空 title todo 应被过滤
 *   - 无效 evidence_span 的 todo 应被过滤
 *   - meeting.status 必须流转到 'summarized'
 *   - summary.content_md 必须包含 LLM 返回的内容
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

const CANNED_LLM_JSON = JSON.stringify({
  summary_md: '## 决策\n- 全员同意 Q4 目标。',
  decisions: ['目标 Q4 进度确认'],
  todos: [
    {
      title: '整理 Q4 OKR 草稿',
      assignee_hint: '陈放',
      due_hint: '本周五',
      evidence_quote: '今天先把草稿过一遍',
      evidence_span: [0, 3000],
    },
    {
      title: '联系设计组对齐视觉',
      assignee_hint: '',
      due_hint: '',
      evidence_quote: '',
      evidence_span: null, // ← 无出处：仍保留，只是没有跳转
    },
    {
      title: '', // ← 应被过滤（空标题）
      evidence_quote: '',
      evidence_span: [0, 1000],
    },
  ],
})

test('总结管线：转录 → LLM → todos 落库（空标题过滤，无出处也保留）', async ({ page }) => {
  test.setTimeout(120_000)
  page.setDefaultTimeout(60_000)
  page.on('console', (msg) => {
    if (msg.text().startsWith('[test]')) {
      console.log('PAGE:', msg.text())
    }
  })

  // 注入 mock：直接劫持 llm/client.ts 的网络调用。
  // 在 import pipeline 之前注入 → 模块的 fetch 已经被替换。
  await page.addInitScript((canned) => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      // 仅拦截 LLM 调用；其它请求走真实 fetch
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        // Anthropic 协议：返回 {content:[{type:'text',text:'...'}]}
        return new Response(
          JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: canned }],
            model: 'mock-model',
            stop_reason: 'end_turn',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return realFetch(input, init)
    }
  }, CANNED_LLM_JSON)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  const result = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onerror = () => rej(new Error('idxb-open-failed'))
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'transcripts', 'kv'], 'readwrite')
        tx.objectStore('kv').put({
          key: 'settings',
          value: {
            theme: 'dark',
            llm_provider: 'anthropic-compatible',
            llm_base_url: 'http://127.0.0.1:9999',
            llm_api_key: 'sk-mock',
            llm_model: 'mock-model',
            asr_provider: 'minimax',
            asr_base_url: 'http://127.0.0.1:9999',
            asr_api_key: 'sk-mock',
            asr_model: 'asr-1.0',
            language: 'zh',
          },
        })
        tx.objectStore('meetings').put({
          id,
          title: '管线测试',
          status: 'transcribed',
          started_at: nowIso,
          ended_at: nowIso,
          updated_at: nowIso,
          deleted_at: null,
          sync_version: 0,
          audio: { duration_ms: 5000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
          source: 'manual',
        })
        tx.objectStore('transcripts').put({
          id: crypto.randomUUID(),
          meeting_id: id,
          language: 'zh',
          engine: 'mock',
          engine_meta: { asr_model: 'mock', asr_base_url: 'mock', mime_type: 'audio/webm' },
          segments: [
            { speaker_label: '说话人 1', text: '今天先把草稿过一遍', start_ms: 0, end_ms: 3000, confidence: 0.99 },
          ],
          speaker_names: {},
          created_at: nowIso,
          updated_at: nowIso,
          deleted_at: null,
          sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })

    const mod = await import('/src/pipeline/summarize.ts')
    await Promise.race([
      mod.runSummarizePipeline(id),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('pipeline-timeout-45s')), 45_000)),
    ])

    return new Promise<{
      meetingStatus: string
      meetingError?: string
      summary: { content_md: string } | null
      todos: Array<{ title: string; assignee?: string; meeting_id?: string; transcript_span: { start_ms: number; end_ms: number } | undefined }>
    }>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onerror = () => rej(new Error('idxb-open-failed'))
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'summaries', 'todos'], 'readonly')
        const m = tx.objectStore('meetings').get(id)
        const s = tx.objectStore('summaries').getAll()
        const t = tx.objectStore('todos').getAll()
        let summaryReturned = false
        let todosReturned = false
        let meetingReturned = false
        const maybeResolve = (): void => {
          if (summaryReturned && todosReturned && meetingReturned) {
            const summaries = s.result as Array<{ meeting_id: string; content_md: string }>
            const summary = summaries.find((x) => x.meeting_id === id)
            const todos = (t.result as Array<{ meeting_id?: string }>).filter(
              (x) => x.meeting_id === id,
            ) as never
            res({
              meetingStatus: (m.result as { status: string }).status,
              meetingError: (m.result as { error?: string }).error,
              summary: summary ? { content_md: summary.content_md } : null,
              todos,
            })
          }
        }
        m.onsuccess = () => { meetingReturned = true; maybeResolve() }
        t.onsuccess = () => { todosReturned = true; maybeResolve() }
        s.onsuccess = () => { summaryReturned = true; maybeResolve() }
        tx.onerror = () => rej(new Error('idxb-tx-error'))
        setTimeout(() => rej(new Error('idxb-readback-timeout-5s')), 5_000)
      }
    })
  })

  expect(result.meetingStatus).toBe('summarized')
  expect(result.meetingError).toBeUndefined()
  expect(result.summary).not.toBeNull()
  expect(result.summary?.content_md).toContain('决策')
  // 空标题被过滤；找不到出处的待办必须保留（丢待办比缺出处糟糕得多）
  expect(result.todos.length).toBe(2)
  const first = result.todos.find((x) => x.title === '整理 Q4 OKR 草稿')
  expect(first?.assignee).toBe('陈放')
  expect(first?.meeting_id).toBeTruthy()
  expect(first?.transcript_span?.start_ms).toBe(0)
  expect(first?.transcript_span?.end_ms).toBe(3000)
  const second = result.todos.find((x) => x.title === '联系设计组对齐视觉')
  expect(second).toBeTruthy()
  expect(second?.transcript_span).toBeUndefined()
})