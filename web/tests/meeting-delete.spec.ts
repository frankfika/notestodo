/**
 * Meeting 删除级联清理 e2e — 真实 UX bug 修复
 *
 * 之前 bug：deleteMeeting 不清理 chatMessages，100 场会议累积后
 * 会浪费磁盘 + 让关联查询变慢。修复后级联删除。
 *
 * 交互已改成「先删 + 可撤销」（不再有 window.confirm）：
 *   1. 删除后关联表都清干净
 *   2. 点提示条上的「撤销」→ 整场会（转录/纪要/待办/对话/音频）原样恢复
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

/** 读回某场会议在各关联表里的行数 */
async function countByMeeting(page: import('@playwright/test').Page, id: string): Promise<Record<string, number>> {
  return page.evaluate(async (id) => new Promise<Record<string, number>>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(
        ['audioChunks', 'transcripts', 'summaries', 'todos', 'chatMessages'],
        'readonly',
      )
      const counts: Record<string, number> = {}
      const tables = ['audioChunks', 'transcripts', 'summaries', 'todos', 'chatMessages']
      let done = 0
      for (const t of tables) {
        const r = tx.objectStore(t).index('meeting_id').count(IDBKeyRange.only(id))
        r.onsuccess = () => {
          counts[t] = r.result
          done++
          if (done === tables.length) res(counts)
        }
      }
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }), id)
}

test('Meeting 删除：级联清理 chatMessages（以及 audioChunks/transcripts/summaries/todos）', async ({ page }) => {
  test.setTimeout(30_000)
  page.on('dialog', (dialog) => void dialog.accept()) // 兜底：万一还有原生弹窗

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // Seed：meeting + 各关联表至少 1 行
  const meetingId = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(
          ['meetings', 'audioChunks', 'transcripts', 'summaries', 'todos', 'chatMessages'],
          'readwrite',
        )
        tx.objectStore('meetings').put({
          id, title: '将被删除的会议', status: 'summarized',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 60_000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
          source: 'manual',
        })
        tx.objectStore('audioChunks').put({
          id: crypto.randomUUID(), meeting_id: id, seq: 1,
          blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
          size_bytes: 3, duration_ms: 1000, created_at: nowIso,
        })
        tx.objectStore('transcripts').put({
          id: crypto.randomUUID(), meeting_id: id, language: 'zh', engine: 'mock',
          engine_meta: {}, segments: [], speaker_names: {},
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('summaries').put({
          id: crypto.randomUUID(), meeting_id: id, template_id: 'default',
          content_md: '## 测试', raw_llm_output: null, generated_at: nowIso, model: 'm',
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('todos').put({
          id: crypto.randomUUID(), kind: 'task', parent_id: null, title: '关联任务', status: 'open',
          meeting_id: id, source: 'meeting', transcript_span: { start_ms: 0, end_ms: 1000, quote: '' },
          sort_order: 0, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        // 两条 chat message：user + assistant
        tx.objectStore('chatMessages').put({
          id: crypto.randomUUID(), meeting_id: id, role: 'user', content: 'hi',
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('chatMessages').put({
          id: crypto.randomUUID(), meeting_id: id, role: 'assistant', content: 'reply',
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })

  // 验证 seed 后各表都有数据
  const beforeDelete = await countByMeeting(page, meetingId)
  expect(beforeDelete.audioChunks).toBe(1)
  expect(beforeDelete.transcripts).toBe(1)
  expect(beforeDelete.summaries).toBe(1)
  expect(beforeDelete.todos).toBe(1)
  expect(beforeDelete.chatMessages).toBe(2)

  // 导航到会议详情 → 点删除按钮
  await page.evaluate((id) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goMeeting: (id: string) => void } } }).__uiStore
    ui?.getState().goMeeting(id)
  }, meetingId)
  await page.waitForTimeout(800)

  // 找到「删除」按钮（btn-danger）+ 点击（不再有 confirm，直接删）
  await page.getByRole('button', { name: '更多' }).click()
  const deleteBtn = page.getByRole('button', { name: '删除会议' }).first()
  await deleteBtn.click({ timeout: 5_000 })
  await page.waitForTimeout(2000) // 等级联删除完成 + 导航

  // 验证：所有关联表都没了对应 meeting_id 的行
  const afterDelete = await countByMeeting(page, meetingId)
  // 核心断言：chatMessages 也被清掉（修复点）
  expect(afterDelete.chatMessages).toBe(0)
  // 其他也应被清
  expect(afterDelete.audioChunks).toBe(0)
  expect(afterDelete.transcripts).toBe(0)
  expect(afterDelete.summaries).toBe(0)
  expect(afterDelete.todos).toBe(0)

  // 会议本身也被删了
  expect(await page.evaluate(async (id) => new Promise<number>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['meetings'], 'readonly')
      const g = tx.objectStore('meetings').get(id)
      g.onsuccess = () => res(g.result ? 1 : 0)
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }), meetingId)).toBe(0)

  // 撤销：提示条上的「撤销」要把整场会原样还原
  await page.getByRole('button', { name: '撤销' }).first().click({ timeout: 5_000 })
  await page.waitForTimeout(1500)

  const afterUndo = await countByMeeting(page, meetingId)
  expect(afterUndo.chatMessages).toBe(2)
  expect(afterUndo.audioChunks).toBe(1)
  expect(afterUndo.transcripts).toBe(1)
  expect(afterUndo.summaries).toBe(1)
  expect(afterUndo.todos).toBe(1)
  expect(await page.evaluate(async (id) => new Promise<number>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['meetings'], 'readonly')
      const g = tx.objectStore('meetings').get(id)
      g.onsuccess = () => res(g.result ? 1 : 0)
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }), meetingId)).toBe(1)
})