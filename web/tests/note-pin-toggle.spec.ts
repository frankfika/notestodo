/**
 * Note pin toggle e2e — 验证点击「置顶/已置顶」按钮立即生效
 *
 * Round 51 验证了 NotesPage 的排序逻辑（pinned 在前）。
 * 本轮验证 togglePin 按钮 + DB 一致性。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('Note pin toggle：DB 写入 pinned 字段 + 列表渲染顺序跟随', async ({ page }) => {
  test.setTimeout(30_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // Seed: 2 篇笔记
  const seedResult = await page.evaluate(async () => {
    const aId = crypto.randomUUID()
    const bId = crypto.randomUUID()
    const old = new Date(Date.now() - 86400_000).toISOString()
    const now = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['notes'], 'readwrite')
        tx.objectStore('notes').put({
          id: aId, title: '笔记 A', body_md: '', pinned: false,
          todo_ids: [], meeting_id: undefined,
          created_at: old, updated_at: old,
          deleted_at: null, sync_version: 0,
        })
        tx.objectStore('notes').put({
          id: bId, title: '笔记 B', body_md: '', pinned: false,
          todo_ids: [], meeting_id: undefined,
          created_at: now, updated_at: now,
          deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return { aId, bId }
  })

  // 导航到笔记 A 详情
  await page.evaluate((id) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goNote: (id: string) => void } } }).__uiStore
    ui?.getState().goNote(id)
  }, seedResult.aId)
  await page.waitForTimeout(800)

  // 点击「置顶」按钮（未 pinned 状态下显示）
  await page.getByRole('button', { name: '置顶' }).click({ timeout: 8_000 })
  await page.waitForTimeout(500)

  // 验证：DB 中 A 的 pinned=true
  const aPinned = await page.evaluate(async (id) => new Promise<boolean>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['notes'], 'readonly')
      const n = tx.objectStore('notes').get(id)
      n.onsuccess = () => res((n.result as { pinned: boolean } | undefined)?.pinned ?? false)
      setTimeout(() => rej(new Error('timeout')), 5_000)
    }
  }), seedResult.aId)
  expect(aPinned).toBe(true)

  // 返回列表
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForTimeout(500)

  // A pinned → A 应在 B 之前（pinned 优先于 updated_at）
  const itemsAfterPin = page.locator('ul li button, ul li a, ul li').filter({ hasText: /笔记 A|笔记 B/ })
  await expect(itemsAfterPin.first()).toBeAttached({ timeout: 5_000 })
  const firstText = await itemsAfterPin.first().innerText()
  expect(firstText).toContain('笔记 A')

  // 再次进入 A → 「已置顶」按钮 → 点击取消
  await itemsAfterPin.first().click({ timeout: 5_000 })
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '已置顶' }).click({ timeout: 5_000 })
  await page.waitForTimeout(500)

  // A.pinned = false again
  const aPinnedAgain = await page.evaluate(async (id) => new Promise<boolean>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['notes'], 'readonly')
      const n = tx.objectStore('notes').get(id)
      n.onsuccess = () => res((n.result as { pinned: boolean } | undefined)?.pinned ?? false)
      setTimeout(() => rej(new Error('timeout')), 5_000)
    }
  }), seedResult.aId)
  expect(aPinnedAgain).toBe(false)
})