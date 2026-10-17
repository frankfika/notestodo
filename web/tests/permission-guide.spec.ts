/**
 * 屏录授权向导（Tauri 未授权）：
 *   - 不在 app 启动时自动弹；只在 useRecorder.phase 真正进入 'recording' 时才考虑弹；
 *   - 需未授权 + 未选「不再提醒」 + 未在 24h snooze 内；
 *   - 「稍后」snooze 24h，再次开始录音不再自动弹（手动入口不受影响）；
 *   - 「不再提醒」持久化，再次开始录音也不再自动弹；
 *   - 浏览器环境完全不出现；手动入口（setPermGuideOpen(true)）始终有效。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

function mockTauri(granted: boolean) {
  return `
    window.__calls = [];
    window.__granted = ${granted};
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (cmd) => {
        window.__calls.push(cmd);
        if (cmd === 'system_audio_status') return { supported: true, permission_required: true, permission_granted: window.__granted, note: 'n' };
        if (cmd === 'system_audio_request_permission') return window.__granted;
        return null;
      },
    };
  `
}

const REC_STATE = {
  phase: 'recording',
  meeting: { id: 'm1', title: 'test', startedAt: new Date().toISOString() },
  elapsedMs: 0,
  chunkCount: 0,
  audioLevel: 0,
  captureMode: 'mic-only' as const,
  captureModeNote: null,
  interrupted: false,
  error: null,
}

/** 驱动录音状态机进入 'recording'，模拟"真的开始录音"事件（见 audio/engine.ts 底部 __setRecorderState）。 */
async function driveRecorderToRecording(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => typeof (window as any).__setRecorderState === 'function')
  // 先回到 idle 防止残留 phase 阻挡 effect（即使是 idle→recording 也只在 phase 变化时触发；
  // 这里显式设 idle，再设 recording，确保 effect 至少触发一次）
  await page.evaluate(() => { (window as any).__setRecorderState({ phase: 'idle' }) })
  await page.evaluate((s) => { (window as any).__setRecorderState(s) }, REC_STATE)
}

async function driveRecorderToIdle(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => typeof (window as any).__setRecorderState === 'function')
  await page.evaluate(() => { (window as any).__setRecorderState({ phase: 'idle' }) })
}

const dialog = (page: import('@playwright/test').Page) =>
  page.getByRole('dialog', { name: '开启系统声音录制' })

test('启动时不会自动弹向导（phase=idle 时静默）', async ({ page }) => {
  await page.addInitScript(mockTauri(false))
  await page.goto(BASE)
  await page.waitForTimeout(2000)
  await expect(dialog(page)).toHaveCount(0)
})

test('phase 进入 recording + 未授权 → 自动弹；授权后变完成态', async ({ page }) => {
  await page.addInitScript(mockTauri(false))
  await page.goto(BASE)
  await driveRecorderToRecording(page)
  const dlg = dialog(page)
  await expect(dlg).toBeVisible({ timeout: 8000 })
  await dlg.getByRole('button', { name: '一键授权' }).click()
  expect(await page.evaluate(() => (window as any).__calls)).toContain('system_audio_request_permission')
  await page.evaluate(() => { (window as any).__granted = true })
  await expect(dlg.getByText('系统声音已就绪')).toBeVisible({ timeout: 5000 })
  await dlg.getByRole('button', { name: '完成' }).click()
  await expect(dlg).toHaveCount(0)
})

test('「稍后」snooze 24h：再次开始录音不再自动弹', async ({ page }) => {
  await page.addInitScript(mockTauri(false))
  await page.goto(BASE)
  await driveRecorderToRecording(page)
  const dlg = dialog(page)
  await expect(dlg).toBeVisible({ timeout: 8000 })
  await dlg.getByRole('button', { name: '稍后' }).click()
  await expect(dlg).toHaveCount(0)

  // 下一次「开始录音」不应再自动弹（受 24h snooze 阻挡）
  await driveRecorderToIdle(page)
  await driveRecorderToRecording(page)
  await page.waitForTimeout(1500)
  await expect(dialog(page)).toHaveCount(0)
})

test('「稍后」后手动入口仍能开（snooze 不影响 setPermGuideOpen）', async ({ page }) => {
  await page.addInitScript(mockTauri(false))
  await page.goto(BASE)
  await driveRecorderToRecording(page)
  const dlg = dialog(page)
  await expect(dlg).toBeVisible({ timeout: 8000 })
  await dlg.getByRole('button', { name: '稍后' }).click()
  await expect(dlg).toHaveCount(0)

  // 手动入口通过 useUI.getState().setPermGuideOpen(true) 打开；snooze 期间仍生效
  await page.evaluate(async () => {
    const mod = await import('/src/state/ui.ts')
    mod.useUI.getState().setPermGuideOpen(true)
  })
  await expect(dialog(page)).toBeVisible({ timeout: 5000 })
})

test('「不再提醒」持久化：再次开始录音不再自动弹', async ({ page }) => {
  await page.addInitScript(mockTauri(false))
  await page.goto(BASE)
  await driveRecorderToRecording(page)
  const dlg = dialog(page)
  await expect(dlg).toBeVisible({ timeout: 8000 })
  await dlg.getByRole('button', { name: '不再提醒' }).click()
  await expect(dlg).toHaveCount(0)

  // 再来一次录音，不应再弹
  await driveRecorderToIdle(page)
  await driveRecorderToRecording(page)
  await page.waitForTimeout(1500)
  await expect(dialog(page)).toHaveCount(0)
})

test('已授权：phase 进入 recording 也不弹', async ({ page }) => {
  await page.addInitScript(mockTauri(true))
  await page.goto(BASE)
  await driveRecorderToRecording(page)
  await page.waitForTimeout(1500)
  await expect(dialog(page)).toHaveCount(0)
})

test('浏览器（无 Tauri）：永不弹', async ({ page }) => {
  await page.goto(BASE)
  await page.waitForTimeout(1000)
  await driveRecorderToRecording(page)
  await page.waitForTimeout(1500)
  await expect(dialog(page)).toHaveCount(0)
})
