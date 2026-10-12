/**
 * 重新生成 Summary e2e — 修复 bug
 *
 * 之前 bug：用户点击「用模板 X 重新生成」→ 写入 KV template 选择 → 调
 * runSummarizePipeline → 但 pipeline 第一件事是「如果已有 summary 直接 return」
 * → 重生成按钮完全无效。
 *
 * 修复：rerunWith() 先 delete 已有 summary + 重置 meeting 状态为 'summarizing'，
 * 让 pipeline 走完正路（template 渲染 → LLM → 落库）。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

const CANNED_LLM_JSON = JSON.stringify({
  summary_md: '## 重新生成的纪要',
  decisions: ['用了新模板'],
  todos: [{ title: '新生成的待办', evidence_span: [0, 500], evidence_quote: '新' }],
})

test('Rerun 重新生成：删旧 summary + 重置 status + 重新跑 pipeline', async ({ page }) => {
  test.setTimeout(60_000)

  await page.addInitScript((canned) => {
    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('/v1/messages') || url.includes('/chat/completions')) {
        return new Response(
          JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: canned }], model: 'm', stop_reason: 'end_turn' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return realFetch(input, init)
    }
  }, CANNED_LLM_JSON)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // Seed：meeting + 旧 summary + transcript
  const meetingId = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    const oldSummaryId = crypto.randomUUID()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'transcripts', 'summaries', 'kv', 'templates'], 'readwrite')
        tx.objectStore('kv').put({
          key: 'settings',
          value: { theme: 'dark', llm_provider: 'anthropic-compatible', llm_base_url: 'http://x', llm_api_key: 'sk', llm_model: 'm', asr_provider: 'minimax', asr_base_url: 'http://x', asr_api_key: 'sk', asr_model: 'm', language: 'zh' },
        })
        tx.objectStore('meetings').put({
          id, title: 'Rerun 测试会议', status: 'summarized',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 30_000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
          source: 'manual',
        })
        tx.objectStore('transcripts').put({
          id: crypto.randomUUID(), meeting_id: id, language: 'zh', engine: 'mock',
          engine_meta: {},
          segments: [{ speaker_label: 'A', text: '旧转录', start_ms: 0, end_ms: 1000, confidence: 0.99 }],
          speaker_names: {},
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        // 旧 summary（canned 内容：旧纪要）
        tx.objectStore('summaries').put({
          id: oldSummaryId, meeting_id: id, template_id: 'builtin-standard',
          content_md: '## 旧纪要', raw_llm_output: null, generated_at: nowIso, model: 'm',
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        // 自定义模板（测试通过 RerunDropdown 选这个）
        tx.objectStore('templates').put({
          id: 'custom-rerun-test', name: '新模板', icon: '🎯', prompt_md: '请按新模板生成 {{meeting.title}}',
          is_default: false, builtin: false,
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })

  // 导航到 meeting 详情
  await page.evaluate((id) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goMeeting: (id: string) => void } } }).__uiStore
    ui?.getState().goMeeting(id)
  }, meetingId)
  await page.waitForTimeout(800)

  // 打开 RerunDropdown → 选「新模板」
  await page.getByRole('button', { name: /深度总结/ }).first().click({ timeout: 5_000 })
  await page.waitForTimeout(300)
  // 下拉项里点「🎯 新模板」
  await page.locator('button:has-text("新模板")').first().click({ timeout: 5_000 })
  await page.waitForTimeout(3000) // 等 pipeline 跑完

  // 验证：旧 summary 已被删，新 summary 落库（canned 内容）
  const after = await page.evaluate(async (id) => new Promise<{
    summaryCount: number
    summaryContentMd: string | undefined
    meetingStatus: string | undefined
    templatesUsed: string | undefined
  }>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['summaries', 'meetings', 'kv'], 'readonly')
      const sAll = tx.objectStore('summaries').getAll()
      const m = tx.objectStore('meetings').get(id)
      const tplKV = tx.objectStore('kv').get(`meeting_template_${id}`)
      sAll.onsuccess = () => m.onsuccess = () => tplKV.onsuccess = () => {
        const summaries = (sAll.result as Array<{ meeting_id: string; content_md: string; template_id: string }>).filter((x) => x.meeting_id === id)
        const tplKVRow = tplKV.result as { value: string } | undefined
        res({
          summaryCount: summaries.length,
          summaryContentMd: summaries[0]?.content_md,
          meetingStatus: (m.result as { status: string } | undefined)?.status,
          templatesUsed: tplKVRow?.value,
        })
      }
      setTimeout(() => rej(new Error('timeout')), 5_000)
    }
  }), meetingId)

  // 修复前 bug：summary 仍是旧内容（pipeline 早 return）
  // 修复后：新 summary（canned LLM 响应）
  expect(after.summaryCount).toBe(1)
  expect(after.summaryContentMd).toContain('重新生成的纪要')
  expect(after.summaryContentMd).not.toContain('旧纪要')
  expect(after.templatesUsed).toBe('custom-rerun-test')
  expect(after.meetingStatus).toBe('summarized')
})