/**
 * System color scheme 实时响应 e2e — 选「system」时 OS 切换深/浅立即跟随
 *
 * 之前 bug：theme='system' 在启动时 resolve 一次，OS 后续切换不响应。
 * 用户体验：早上开 app（白天，浅色）→ 晚上不切换到深色。
 *
 * 修复：ui.ts 注册 matchMedia('prefers-color-scheme: dark') 的 change 监听，
 * 当 ui store 的 theme === 'system' 时重新 resolve + 应用。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('System 主题：OS 切换深/浅时实时跟随', async ({ page }) => {
  test.setTimeout(30_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // 导航到 Settings + 选「system」
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goSettings: () => void } } }).__uiStore?.getState().goSettings())
  await page.waitForTimeout(500)
  await page.locator('select').filter({ has: page.locator('option[value="system"]') }).first().selectOption('system')
  await page.waitForTimeout(300)

  // 直接调 applyTheme('system') 让 ui store 进入 system 状态（SettingsPage patch 写入的是 AppSettings 的 theme，与 ui store 不同；这里测 ui store + DOM 联动）
  await page.evaluate(() => {
    ;(window as unknown as { __uiStore?: { getState: () => { setTheme: (t: 'dark' | 'light' | 'system') => void } } }).__uiStore?.getState().setTheme('system')
  })
  await page.waitForTimeout(200)

  // 1) OS 深色 → <html>.classList 应含 'dark'
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  expect(isDark).toBe(true)

  // 2) OS 切换到浅色 → matchMedia change 事件触发 → classList 移除 'dark'
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForTimeout(300)
  const isLight = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  expect(isLight).toBe(false)

  // 3) 再切回深色 → 再次跟随
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  const isDarkAgain = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  expect(isDarkAgain).toBe(true)

  // 4) 用户手动切到 'dark' 后，OS 改浅色不应影响（用户已覆盖 system）
  await page.evaluate(() => {
    ;(window as unknown as { __uiStore?: { getState: () => { setTheme: (t: 'dark' | 'light' | 'system') => void } } }).__uiStore?.getState().setTheme('dark')
  })
  await page.waitForTimeout(200)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForTimeout(300)
  // 用户设了 'dark' → matchMedia listener 检测到 theme !== 'system' → 不重设 → 仍是 dark
  const stillDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  expect(stillDark).toBe(true)
})