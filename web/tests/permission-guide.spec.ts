/**
 * 屏录授权向导：Tauri 未授权 → 首启自动弹出；授权后自动切到完成态；
 * 「不再提醒」持久化；浏览器环境完全不出现。
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

test('Tauri 未授权：向导自动弹出，授权后变完成态', async ({ page }) => {
  await page.addInitScript(mockTauri(false))
  await page.goto(BASE)
  const dlg = page.getByRole('dialog', { name: '开启系统声音录制' })
  await expect(dlg).toBeVisible({ timeout: 8000 })
  await dlg.getByRole('button', { name: '一键授权' }).click()
  expect(await page.evaluate(() => (window as any).__calls)).toContain('system_audio_request_permission')
  await page.evaluate(() => { (window as any).__granted = true })
  await expect(dlg.getByText('系统声音已就绪')).toBeVisible({ timeout: 5000 })
  await dlg.getByRole('button', { name: '完成' }).click()
  await expect(dlg).toHaveCount(0)
})

test('「不再提醒」持久化，刷新后不再弹', async ({ page }) => {
  await page.addInitScript(mockTauri(false))
  await page.goto(BASE)
  const dlg = page.getByRole('dialog', { name: '开启系统声音录制' })
  await expect(dlg).toBeVisible({ timeout: 8000 })
  await dlg.getByRole('button', { name: '不再提醒' }).click()
  await expect(dlg).toHaveCount(0)
  await page.reload()
  await page.waitForTimeout(2500)
  await expect(page.getByRole('dialog', { name: '开启系统声音录制' })).toHaveCount(0)
})

test('已授权 / 浏览器：不弹向导', async ({ page }) => {
  await page.goto(BASE)
  await page.waitForTimeout(1500)
  await expect(page.getByRole('dialog', { name: '开启系统声音录制' })).toHaveCount(0)
})
