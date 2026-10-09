/**
 * Notes 列表 pinned 排序 e2e — 修复 bug
 *
 * 之前 bug：NotesPage 用 db.notes.orderBy('updated_at').reverse() 直接渲染，
 * 没有把 pinned=true 的笔记置顶。用户 pin 一篇笔记，期望它上浮——结果没动。
 *
 * 修复：加 useMemo sort：pinned 在前（内部按 updated_at 倒序），其余按 updated_at 倒序。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('Notes 列表：pinned 笔记排在最前', async ({ page }) => {
  test.setTimeout(30_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // Seed：3 篇笔记，note2 pinned（但 updated_at 较旧 → 按 updated_at 应排中间）
  await page.evaluate(async () => {
    const now = new Date()
    const mk = (offset: number, pinned: boolean) => {
      const dt = new Date(now)
      dt.setDate(dt.getDate() + offset)
      return {
        id: crypto.randomUUID(),
        title: pinned ? '置顶笔记' : `笔记 ${offset}`,
        body_md: '',
        meeting_id: undefined,
        todo_ids: [],
        pinned,
        created_at: dt.toISOString(),
        updated_at: dt.toISOString(),
        deleted_at: null,
        sync_version: 0,
      }
    }
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['notes'], 'readwrite')
        tx.objectStore('notes').put(mk(-1, false))   // 昨天，非 pinned
        tx.objectStore('notes').put(mk(-3, true))    // 3 天前，pinned
        tx.objectStore('notes').put(mk(0, false))    // 今天，非 pinned
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
  })

  // 导航到 NotesPage
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goNotes: () => void } } }).__uiStore?.getState().goNotes())
  await page.waitForTimeout(600)

  // 列表渲染 3 条
  const listItems = page.locator('ul li button, ul li a, ul li').filter({ hasText: /置顶笔记|笔记/ })
  await expect(listItems.first()).toBeAttached({ timeout: 5_000 })

  // 关键断言：第一个是「置顶笔记」（pinned=true），即使 updated_at 最旧
  const firstNoteTitle = await listItems.first().innerText()
  expect(firstNoteTitle).toContain('置顶笔记')

  // 列表文本顺序
  const allTexts = await listItems.allInnerTexts()
  expect(allTexts[0]).toContain('置顶笔记')

  // 后面 2 条非 pinned 笔记按 updated_at 倒序：今天的「笔记 0」在前
  const todayIdx = allTexts.findIndex((t) => t.includes('笔记 0'))
  const yesterdayIdx = allTexts.findIndex((t) => t.includes('笔记 -1'))
  expect(todayIdx).toBeGreaterThan(0) // 排在置顶笔记之后
  expect(todayIdx).toBeLessThan(yesterdayIdx) // 今天的 > 昨天的（updated_at 倒序）
})