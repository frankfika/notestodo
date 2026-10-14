/**
 * 视觉 UX 审计 — 截图主页面，提供人工审查用。
 * 这一屏的内容是给 Claude Code 架构师/UX 验收看的：直接呈现 UI 真实状态。
 */
import { test } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function dismissOnboarding(page: import('@playwright/test').Page): Promise<void> {
  const closeBtn = page.locator('button[aria-label="关闭"]').first()
  if (await closeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await closeBtn.click()
  }
}

async function fillSeed(page: import('@playwright/test').Page): Promise<void> {
  // 注入种数据让 UI 更真实
  await page.evaluate(async () => {
    return new Promise<void>((res) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'notes', 'todos', 'templates'], 'readwrite')
        const now = new Date().toISOString()
        if (tx.objectStoreNames.contains('meetings')) {
          const ms = tx.objectStore('meetings')
          ;['产品评审会', '1on1 with 王五', '周 OKR 对齐'].forEach((t, i) => {
            ms.put({
              id: `seed-m-${i}`, title: t, source: 'manual', status: 'summarized',
              started_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
              audio: { format: 'audio/webm', codec: 'opus', duration_ms: 1800000, chunk_count: 6, size_bytes: 9000000, gaps: [] },
              note_id: `seed-n-${i}`,
              created_at: now, updated_at: now, deleted_at: null, sync_version: 0,
            })
          })
        }
        if (tx.objectStoreNames.contains('notes')) {
          const ns = tx.objectStore('notes')
          ;[0,1,2].forEach((i) => {
            ns.put({
              id: `seed-n-${i}`, title: '讨论要点', body_md: '',
              meeting_id: `seed-m-${i}`, todo_ids: [],
              pinned: false, created_at: now, updated_at: now, deleted_at: null, sync_version: 0,
            })
          })
        }
        if (tx.objectStoreNames.contains('todos')) {
          const ts = tx.objectStore('todos')
          ts.put({
            id: 'seed-obj-1', kind: 'objective', parent_id: null,
            title: 'Q4 上线 v1.0', status: 'open',
            source: 'manual', sort_order: 0,
            created_at: now, updated_at: now, deleted_at: null, sync_version: 0,
          })
          ts.put({
            id: 'seed-kr-1', kind: 'kr', parent_id: 'seed-obj-1',
            title: '完成 50 场访谈', status: 'open',
            source: 'manual', sort_order: 1, due_date: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
            created_at: now, updated_at: now, deleted_at: null, sync_version: 0,
          })
          ts.put({
            id: 'seed-task-1', kind: 'task', parent_id: 'seed-kr-1',
            title: '约访谈策划', status: 'open',
            source: 'manual', sort_order: 2,
            assignee: '张三',
            created_at: now, updated_at: now, deleted_at: null, sync_version: 0,
          })
          ts.put({
            id: 'seed-task-2', kind: 'task', parent_id: null,
            title: '独立任务：回复法务邮件', status: 'open',
            source: 'manual', sort_order: 3,
            due_date: new Date().toISOString().slice(0, 10),
            created_at: now, updated_at: now, deleted_at: null, sync_version: 0,
          })
        }
        tx.oncomplete = () => res()
      }
    })
  })
}

test('视觉审计 — Today / Meetings / Todos / Notes / Settings', async ({ page }) => {
  await page.goto(BASE)
  await dismissOnboarding(page)
  await fillSeed(page)
  await page.waitForTimeout(400)

  await page.screenshot({ path: 'tests/screenshots/visual-today.png', fullPage: false })

  await page.getByRole('button', { name: '会议' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'tests/screenshots/visual-meetings.png', fullPage: false })

  await page.getByRole('button', { name: '会议' }).first().click()
  await page.waitForTimeout(200)
  // 点开第一场
  await page.getByText('产品评审会').first().click().catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'tests/screenshots/visual-meeting-detail.png', fullPage: false })

  await page.locator('aside').getByRole('button', { name: 'OKR' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'tests/screenshots/visual-todos.png', fullPage: false })

  await page.getByRole('button', { name: '笔记' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'tests/screenshots/visual-notes.png', fullPage: false })

  await page.getByRole('button', { name: '模板' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'tests/screenshots/visual-templates.png', fullPage: false })

  await page.getByRole('button', { name: '设置' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'tests/screenshots/visual-settings.png', fullPage: false })
})