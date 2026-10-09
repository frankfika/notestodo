/**
 * Onboarding 自动消失 e2e — 用户首次创建会议/todo/笔记/录音，
 * onboarding_done_v1 被 hook 写入 → Onboarding 组件卸载 → 不再挡 UI。
 *
 * 修复历程：round 23 修了 NotFoundError（hook zone 问题），
 * 但 auto-dismiss 的端到端验证从未做。
 *
 * 测试直接验证 hook 链：点击「● 开始录音」→ meeting 写入 → hook 触发
 * dismissIfPending → kv.put(onboarding_done_v1, true) → liveQuery 卸载 Onboarding。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
})

test('Onboarding：首次创建 meeting 后 onboarding 自动消失', async ({ page }) => {
  test.setTimeout(30_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  // 初始：onboarding_done_v1 未设置
  const beforeKv = await page.evaluate(async () => {
    return new Promise<boolean>((res) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const r = req.result.transaction('kv', 'readonly').objectStore('kv').get('onboarding_done_v1')
        r.onsuccess = () => res(r.result?.value === true)
      }
    })
  })
  expect(beforeKv).toBe(false) // fresh DB, onboarding 不应已 dismissed

  // 点击「● 开始录音」按钮（fake-mic 自动同意权限）→ 触发 meeting 创建 + hook
  await page.getByRole('button', { name: /● 开始录音/ }).first().click({ timeout: 8_000 })
  await page.waitForTimeout(2000) // hook setTimeout(0) + kv.put + liveQuery 触发组件卸载

  // 立即停止（不实际录音）
  const stopBtn = page.getByRole('button', { name: /■ 停止/ }).first()
  if (await stopBtn.count() > 0) await stopBtn.click({ timeout: 5_000 })
  await page.waitForTimeout(500)

  // 验证：onboarding_done_v1 现在 = true（hook 触发并写入）
  const afterKv = await page.evaluate(async () => {
    return new Promise<boolean>((res) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const r = req.result.transaction('kv', 'readonly').objectStore('kv').get('onboarding_done_v1')
        r.onsuccess = () => res(r.result?.value === true)
      }
    })
  })
  expect(afterKv).toBe(true)

  // Onboarding 卡片不应再渲染（liveQuery 触发组件卸载）
  // 组件显示「拾贝 · 新用户引导」文本
  const onboardingVisible = await page.evaluate(() => {
    const root = document.getElementById('root')
    return root ? root.textContent?.includes('新用户引导') : false
  })
  expect(onboardingVisible).toBe(false)

  // 验证 meeting 也被创建（确保 hook 链触发）
  const meetingCount = await page.evaluate(async () => {
    return new Promise<number>((res) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const r = req.result.transaction('meetings', 'readonly').objectStore('meetings').count()
        r.onsuccess = () => res(r.result)
      }
    })
  })
  expect(meetingCount).toBe(1)
})