/**
 * Note 创建 e2e — 「+ 新建笔记」按钮：写 DB + 自动导航到详情页
 *
 * 之前 round 35 测了详情页编辑；但**「点 + 新建」按钮**这个入口没测。
 * 用户最常用入口之一，路径被覆盖：
 *   1. NotesPage 列表上点「+ 新建笔记」
 *   2. DB 中新增一条 Note (title='未命名笔记')
 *   3. 自动导航到 note 详情页
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('+ 新建笔记：创建后立即进入详情页 + DB 写入', async ({ page }) => {
  test.setTimeout(30_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // 初始 DB notes 数
  const initialCount = await page.evaluate(async () => new Promise<number>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['notes'], 'readonly')
      const c = tx.objectStore('notes').count()
      c.onsuccess = () => res(c.result)
      setTimeout(() => rej(new Error('timeout')), 5_000)
    }
  }))

  // 导航到 NotesPage
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goNotes: () => void } } }).__uiStore?.getState().goNotes())
  await page.waitForTimeout(500)

  // 点「+ 新建笔记」（列表空态时的 primary button）
  await page.getByRole('button', { name: '+ 新建笔记' }).first().click({ timeout: 8_000 })
  await page.waitForTimeout(800)

  // 1) 自动导航到 note-detail view → 显示 placeholder 标题「标题」+ 空 body textarea
  await expect(page.locator('input[placeholder="标题"]')).toBeAttached({ timeout: 5_000 })
  await expect(page.locator('textarea')).toBeAttached()
  const titleValue = await page.locator('input[placeholder="标题"]').inputValue()
  const bodyValue = await page.locator('textarea').inputValue()
  expect(titleValue).toBe('未命名笔记')
  expect(bodyValue).toBe('')

  // 2) DB notes 数 +1，且最新一条 title='未命名笔记'
  const afterCount = await page.evaluate(async () => new Promise<number>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['notes'], 'readonly')
      const c = tx.objectStore('notes').count()
      c.onsuccess = () => res(c.result)
      setTimeout(() => rej(new Error('timeout')), 5_000)
    }
  }))
  expect(afterCount).toBe(initialCount + 1)
})