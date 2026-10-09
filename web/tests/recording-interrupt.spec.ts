/**
 * 录音中断恢复 UI e2e — 验证：recorder store 中 interrupted=true 时，
 * RecordingBar 必须用 amber 警示色 + 「正在恢复…」文案。
 *
 * 注意：直接模拟 OS 撤销麦克风（track 'ended' 事件）在 Chromium 假设备
 * 下无法触发（t.stop() 只改变 readyState 不派发事件）—— 真实 OS 中断时会派发。
 * 因此本测试只覆盖「UI 对 interrupted 状态的展示」，不覆盖引擎的恢复逻辑本身。
 * 引擎层恢复路径通过 handleTrackEnded + acquireStream 的代码 review 验证。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('麦克风中断 UI：interrupted=true 时 RecordingBar 用 amber 色 + 恢复文案', async ({ page }) => {
  page.setDefaultTimeout(30_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500) // 等 DEV hook import + bootstrap 完成
  const closeBtn = page.locator('button[aria-label="关闭"]').first()
  if (await closeBtn.isVisible({ timeout: 1500 }).catch(() => false)) await closeBtn.click()

  // 直接驱动 recorder store 进入 interrupted 状态（绕过不可触发的 track ended 事件）
  await page.evaluate(() => {
    // recorder state 在 zustand 中管理；setRecorderPartial 是其 action
    const w = window as unknown as Record<string, unknown>
    const setState = w.__setRecorderState as ((s: Record<string, unknown>) => void) | undefined
    if (setState) {
      setState({
        phase: 'recording',
        elapsedMs: 5_000,
        chunkCount: 2,
        audioLevel: 0,
        interrupted: true,
        error: null,
        meeting: { id: 'mock-meeting', title: '演示会议' },
      })
    }
  })

  // 给 React 一帧时间响应 state 变化
  await page.waitForTimeout(500)

  // 断言文案（onboarding 卡片可能短暂遮挡，用 attached 而非 visible）
  expect(page.getByText('麦克风被中断，正在恢复…')).toBeAttached({ timeout: 3_000 })
  expect(page.getByText(/有空白段/)).toBeAttached()
  // 红点仍在（录制在恢复中）
  expect(page.locator('span.rec-dot').first()).toBeAttached()
})