/** 移动端响应式截图 — iPhone 13 + iPad mini */
import { test } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function dismissOnboarding(page: import('@playwright/test').Page): Promise<void> {
  const closeBtn = page.locator('button[aria-label="关闭"]').first()
  if (await closeBtn.isVisible({ timeout: 1500 }).catch(() => false)) await closeBtn.click()
}

test('iPhone 13 视口（375x812）', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(BASE)
  await dismissOnboarding(page)
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'tests/screenshots/mobile-today.png', fullPage: false })
})

test('iPhone 13 — 各页面', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(BASE)
  await dismissOnboarding(page)
  await page.waitForTimeout(300)
  for (const [label, fname] of [
    ['会议', 'mobile-meetings'],
    ['笔记', 'mobile-notes'],
    ['任务', 'mobile-todos'],
  ] as const) {
    // 桌面 sidebar 在 md 以下隐藏；用 nav[aria-label="主导航"] 锁定移动 tab bar
    await page.locator('nav[aria-label="主导航"]').getByRole('button', { name: label }).click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `tests/screenshots/${fname}.png`, fullPage: false })
  }
  // 看板 / 周报 并入「任务」页内切换
  await page.getByRole('tab', { name: '看板' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'tests/screenshots/mobile-board.png', fullPage: false })
  await page.getByRole('button', { name: '周报 →' }).click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'tests/screenshots/mobile-report.png', fullPage: false })
})

test('iPad mini 视口（768x1024）', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.goto(BASE)
  await dismissOnboarding(page)
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'tests/screenshots/ipad-today.png', fullPage: false })
})