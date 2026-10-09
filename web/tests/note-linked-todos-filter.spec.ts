/**
 * Note 关联任务列表过滤 — 软删除 todo 不显示
 *
 * 之前 bug：NoteDetailPage 的「关联任务」section 查询 todos 不过滤 deleted_at，
 * 用户软删除 todo 后 → todo 仍在笔记的关联列表里出现。
 *
 * 修复：linkedTodos 加 .filter((t) => t.deleted_at === null)。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('Note 关联任务：软删除的 todo 不在「关联任务」section 显示', async ({ page }) => {
  test.setTimeout(30_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // Seed：1 个 note + 1 个 active todo + 1 个软删除 todo（都 origin_note_id = noteId）
  const noteId = await page.evaluate(async () => {
    const noteId = crypto.randomUUID()
    const activeTodoId = crypto.randomUUID()
    const deletedTodoId = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['notes', 'todos'], 'readwrite')
        tx.objectStore('notes').put({
          id: noteId, title: 'E2E 关联过滤笔记', body_md: '',
          pinned: false, todo_ids: [],
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('todos').put({
          id: activeTodoId, kind: 'task', parent_id: null, title: '保留任务', status: 'open',
          source: 'note', origin_note_id: noteId,
          sort_order: 0, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('todos').put({
          id: deletedTodoId, kind: 'task', parent_id: null, title: '已删除任务', status: 'cancelled',
          source: 'note', origin_note_id: noteId,
          sort_order: 1, created_at: nowIso, updated_at: nowIso,
          deleted_at: nowIso, sync_version: 0, // 已软删除
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return noteId
  })

  // 导航到笔记详情
  await page.evaluate((id) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goNote: (id: string) => void } } }).__uiStore
    ui?.getState().goNote(id)
  }, noteId)
  await page.waitForTimeout(800)

  // section title 应显示 (1)：只算保留任务
  const sectionTitle = page.locator('.section-title:has-text("从这条笔记创建的任务")')
  await expect(sectionTitle).toContainText('(1)', { timeout: 5_000 })

  // 列表只渲染保留任务
  expect(page.locator('li:has-text("保留任务")')).toHaveCount(1)

  // 已软删除任务不应渲染（修复前 bug 会渲染）
  await expect(page.locator('li:has-text("已删除任务")')).toHaveCount(0, { timeout: 3_000 })

  // 修复前的对照验证：DB 中 todo 仍在（soft delete）
  const dbCount = await page.evaluate(async (id) => new Promise<number>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['todos'], 'readonly')
      const r = tx.objectStore('todos').index('origin_note_id').count(IDBKeyRange.only(id))
      r.onsuccess = () => res(r.result)
      setTimeout(() => rej(new Error('timeout')), 5_000)
    }
  }), noteId)
  expect(dbCount).toBe(2) // DB 仍有 2 条（含软删除），UI 只显示 1 条
})