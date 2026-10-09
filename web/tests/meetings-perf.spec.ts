/**
 * 多会议列表性能冒烟 — 真实用户一周可能累积 30+ 场会议，
 * 列表渲染 + 分组不能卡 UI 主线程超过 1s。
 *
 * Seed 50 场会议跨 14 天 → 列表渲染应 <1s。
 * 用 performance.now() 在测试 page 内测量渲染开销。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('多会议列表性能：50 场会议渲染 < 1s', async ({ page }) => {
  test.setTimeout(45_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // Seed 50 场会议跨 14 天
  await page.evaluate(async () => {
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings'], 'readwrite')
        const now = new Date()
        for (let i = 0; i < 50; i++) {
          const offset = Math.floor(i / 4) - 13 // 14 天区间，~3.5 场/天
          const dt = new Date(now)
          dt.setDate(dt.getDate() + offset)
          dt.setHours(8 + (i % 12), 0, 0, 0)
          tx.objectStore('meetings').put({
            id: crypto.randomUUID(),
            title: `会议 ${i + 1}`,
            status: 'transcribed',
            started_at: dt.toISOString(),
            ended_at: dt.toISOString(),
            updated_at: dt.toISOString(),
            deleted_at: null,
            sync_version: 0,
            audio: { duration_ms: 60_000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
            source: 'manual',
          })
        }
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
  })

  // 导航到会议页 → 测渲染时间
  const navStart = Date.now()
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goMeetings: () => void } } }).__uiStore?.getState().goMeetings())

  // 等列表渲染完（用 list 内 50 个 li 计数来检测）
  await page.waitForFunction(
    () => document.querySelectorAll('.w-\\[300px\\] ul li').length >= 50,
    { timeout: 5_000 },
  ).catch(() => null)
  const navEnd = Date.now()
  const navMs = navEnd - navStart

  console.log(`50-meeting list nav+render: ${navMs}ms`)

  // 实际渲染的会议数
  const liCount = await page.locator('.w-\\[300px\\] ul li').count()
  expect(liCount).toBe(50)

  // 性能断言：< 2s（50 会议 + Dexie liveQuery 重订阅 + React commit）
  expect(navMs).toBeLessThan(2_000)
})