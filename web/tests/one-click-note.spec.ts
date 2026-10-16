/**
 * 一条龙笔记管线 e2e：速记 + 转录 → **一次** LLM 调用 → 标题 / 笔记 / 待办。
 * 验证：
 *   1. 用户速记进入同一次 LLM 请求（且只发 1 次请求）
 *   2. AI 标题只替换默认占位标题
 *   3. 待办出处三级回退：evidence_time("mm:ss") → 原句匹配 → 无出处（均保留）
 *   4. 笔记正文写进 meeting 的 note（不再需要手动「整理笔记」）
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

const CANNED = JSON.stringify({
  title: 'Q4 预算与上线评审',
  summary_md: '## 结论\n- 预算压到 80 万',
  todos: [
    { title: '发预算表', assignee_hint: '王磊', evidence_quote: '预算表发给财务', evidence_time: '00:06' },
    { title: '推进合同', evidence_quote: '负责跟法务推进合同', evidence_time: '' },
    { title: '订会议室', evidence_quote: '', evidence_time: '' },
  ],
})

test('一条龙：速记进 prompt、AI 标题、待办三级出处回退、笔记自动写入', async ({ page }) => {
  test.setTimeout(60_000)
  await page.addInitScript((canned) => {
    const w = window as unknown as { __llmCalls: string[] }
    w.__llmCalls = []
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/chat/completions')) {
        w.__llmCalls.push(String(init?.body ?? ''))
        return new Response(JSON.stringify({ choices: [{ message: { content: canned } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return realFetch(input, init)
    }
  }, CANNED)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  const r = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const noteId = crypto.randomUUID()
    const iso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const tx = req.result.transaction(['meetings', 'notes', 'transcripts', 'kv', 'scribbles'], 'readwrite')
        tx.objectStore('kv').put({ key: 'settings', value: { llm_provider: 'openai-compatible', llm_base_url: 'http://127.0.0.1:9999/v1', llm_api_key: 'sk', llm_model: 'm', language: 'zh' } })
        tx.objectStore('meetings').put({
          id, title: '会议 · 2026-10-14 16:32', status: 'transcribed', started_at: iso, ended_at: iso, updated_at: iso, created_at: iso,
          deleted_at: null, sync_version: 0, source: 'manual', note_id: noteId,
          audio: { duration_ms: 30000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, gaps: [] },
        })
        // 速记存 scribbles 表（一行一条，无时间锚点 → 裸 bullet）
        tx.objectStore('scribbles').put({ id: crypto.randomUUID(), meeting_id: id, t_ms: null, text: 'q4 预算??', created_at: iso })
        tx.objectStore('scribbles').put({ id: crypto.randomUUID(), meeting_id: id, t_ms: null, text: '上线风险', created_at: new Date(Date.now() + 1).toISOString() })
        tx.objectStore('notes').put({ id: noteId, title: '会议 · 2026-10-14 16:32', body_md: '', meeting_id: id, todo_ids: [], pinned: false, created_at: iso, updated_at: iso, deleted_at: null, sync_version: 0 })
        tx.objectStore('transcripts').put({
          id: crypto.randomUUID(), meeting_id: id, language: 'zh', engine: 'mock', engine_meta: {}, speaker_names: {},
          segments: [
            { speaker_label: '说话人 1', text: '预算压到八十万。', start_ms: 0, end_ms: 5000 },
            { speaker_label: '说话人 1', text: '王磊你把预算表发给财务。', start_ms: 6000, end_ms: 12000 },
            { speaker_label: '说话人 2', text: '好，李娜负责跟法务推进合同。', start_ms: 20000, end_ms: 26000 },
          ],
          created_at: iso, updated_at: iso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error)
      }
    })
    const mod = await import('/src/pipeline/summarize.ts')
    await mod.runSummarizePipeline(id)
    return new Promise<unknown>((res) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const tx = req.result.transaction(['meetings', 'notes', 'todos'], 'readonly')
        const m = tx.objectStore('meetings').get(id)
        const n = tx.objectStore('notes').get(noteId)
        const t = tx.objectStore('todos').getAll()
        tx.oncomplete = () => res({
          meeting: m.result, note: n.result,
          todos: (t.result as Array<{ meeting_id?: string }>).filter((x) => x.meeting_id === id),
          calls: (window as unknown as { __llmCalls: string[] }).__llmCalls,
        })
      }
    })
  }) as {
    meeting: { title: string; status: string }
    note: { title: string; body_md: string }
    todos: Array<{ title: string; transcript_span?: { start_ms: number }; notes_md: string }>
    calls: string[]
  }

  expect(r.calls.length).toBe(1)
  expect(r.calls[0]).toContain('q4 预算??')
  expect(r.calls[0]).toContain('<scribble>')
  expect(r.meeting.status).toBe('summarized')
  expect(r.meeting.title).toBe('Q4 预算与上线评审')
  expect(r.note.title).toBe('Q4 预算与上线评审')
  expect(r.note.body_md).toContain('预算压到 80 万')

  expect(r.todos.length).toBe(3)
  const byTitle = (t: string) => r.todos.find((x) => x.title === t)!
  expect(byTitle('发预算表').transcript_span?.start_ms).toBe(6000) // 时间戳 00:06
  expect(byTitle('推进合同').transcript_span?.start_ms).toBe(20000) // 原句匹配
  expect(byTitle('订会议室').transcript_span).toBeUndefined() // 无出处也保留
})
