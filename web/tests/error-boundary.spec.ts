/**
 * ErrorBoundary e2e — 渲染崩溃后展示可操作的恢复卡片（重新加载 + 反馈邮件），
 * 而不是白屏。
 *
 * 触发方式：DEV-only 测试钩子 `__ebTestThrowOnce` 设为 false 时，
 * App 首次挂载 useEffect 中抛错 → 外层 ErrorBoundary 捕获 → 渲染恢复 UI。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('ErrorBoundary：渲染崩溃后展示恢复卡片（错误信息 + 重新加载 + 反馈按钮）', async ({ page }) => {
  test.setTimeout(30_000)

  // 在 goto 前打开「下一个 render 抛错」开关 —— page 加载时首次 useEffect 即触发
  await page.addInitScript(() => {
    ;(window as unknown as { __ebTestThrowOnce?: boolean }).__ebTestThrowOnce = true
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000) // 给 React 时间 mount + useEffect 触发 + 边界捕获

  // ErrorBoundary 应捕获错误并显示恢复卡片
  await expect(page.getByText('应用遇到错误')).toBeAttached({ timeout: 5_000 })

  // 错误消息片段（含 stack 片段）应显示
  await expect(page.getByText(/ErrorBoundary e2e/)).toBeAttached()

  // 重新加载按钮 + 反馈邮件链接都可见
  await expect(page.getByRole('button', { name: '重新加载' })).toBeAttached()
  await expect(page.getByRole('link', { name: '反馈问题' })).toBeAttached()

  // 反馈邮件的 href 含 mailto:
  const href = await page.getByRole('link', { name: '反馈问题' }).getAttribute('href')
  expect(href).toContain('mailto:')

  // 应用已替换为恢复视图：sidebar 不存在
  await expect(page.locator('nav[aria-label="主导航"]')).toHaveCount(0)
})