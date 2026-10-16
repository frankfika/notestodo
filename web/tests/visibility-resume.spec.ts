/**
 * 标签页可见性 e2e — 录音时切走/回到标签页不丢失。
 *
 * 真实场景（macOS / Windows）：用户开会时按 ⌘Tab 切走看 Slack，几秒后回来。
 * 之前 visibilitychange 只设 interrupted 标志，mic 实际保持录音状态。
 * 修复后：如果 mic track 在 hidden 期间被撤销，恢复时主动 reopen。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
})

test('标签页切走 → interrupted=true；回来 → 自动恢复正常', async ({ page }) => {
  page.setDefaultTimeout(20_000)

  await page.goto(BASE)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // 开始录音
  await page.getByRole('button', { name: /● 开始录音/ }).first().click()
  await expect(page.locator('span.rec-dot').first()).toBeVisible({ timeout: 8000 })
  await page.waitForTimeout(1500)

  // 1) 切走标签页 — 触发 visibilitychange('hidden')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(300)

  // UI 应进入 interrupted 状态（amber 色 + 恢复文案）
  await expect(page.getByText('麦克风被中断，正在恢复…')).toBeAttached({ timeout: 3_000 })

  // 2) 切回标签页
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(500)

  // interrupted 应清回 false → 中断警示消失（速记页本身不再重复顶栏）
  await expect(page.getByText('麦克风被中断，正在恢复…')).toHaveCount(0, { timeout: 3_000 })

  // 3) 停止（验证 finaliseMeeting 在 visibility 切换之后仍正常）
  await page.getByRole('button', { name: /■ 停止/ }).first().click()
  await expect(page.locator('span.rec-dot')).toHaveCount(0, { timeout: 12_000 })
})