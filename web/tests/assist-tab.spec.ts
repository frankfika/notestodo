/**
 * Live Assist Tab (Phase-2 item 5) 烟雾测试
 *
 * 覆盖：
 *   1. 会议详情页 Tab 栏出现「助手」
 *   2. 未配知识库 → 空态 + CTA 跳到设置
 *   3. 配了文件夹但无索引 → "去索引" 空态
 *
 * 不验证具体 keyword 匹配结果（语义层面的事留给单元/手动测试）。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
})

test.describe('Live Assist Tab', () => {

  test('未配知识库：助手 Tab 显示空态 + 跳到设置 CTA', async ({ page }) => {
    await page.goto(BASE)
    // 关 onboarding
    const closeBtn = page.locator('button[aria-label="关闭"]').first()
    if (await closeBtn.isVisible({ timeout: 1500 }).catch(() => false)) await closeBtn.click()

    // 走到会议列表
    await page.getByRole('button', { name: /● 会议/ }).first().click()
    await page.waitForTimeout(200)
    // 点列表里第一条已存在的会议（先 seed 一个）
    await page.evaluate(async () => {
      // 用命令面板路径更快；这里走最小 path：直接用 Today 上「新建」按钮 → 录制
      // 然后停止 → 列表里就有 meeting；点击它进详情
    })
    // 走命令面板「新建笔记」无关；用更直接路径：在会议页点「新建」快速拿到一个 meeting
    await page.getByRole('button', { name: /● 新建录音/ }).first().click()
    await page.waitForTimeout(400)
    // 立刻停止
    await page.getByRole('button', { name: /■ 停止/ }).first().click()
    await page.waitForTimeout(800)
    // 停止后自动进入这场会议的详情页（一条龙，不需要再点列表）

    // 切到「助手」Tab
    await page.getByRole('button', { name: '助手' }).first().click()
    await expect(page.getByText(/还没有知识库文件夹/)).toBeVisible({ timeout: 5000 })
    const cta = page.getByRole('button', { name: /→ 设置/ }).first()
    await expect(cta).toBeVisible()
  })

  test('有 knowledge_folders 但无索引：显示「去索引」空态', async ({ page }) => {
    // 先把 knowledge_folders 写到 settings
    await page.goto(BASE)
    await page.evaluate(async () => {
      const row = await new Promise<{ value: Record<string, unknown> } | undefined>((res) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('kv', 'readonly')
          const r = tx.objectStore('kv').get('settings')
          r.onsuccess = () => res(r.result as { value: Record<string, unknown> })
        }
      })
      const next = { ...(row?.value ?? {}), knowledge_folders: ['https://example.com/seed.md'] }
      await new Promise<void>((res, rej) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('kv', 'readwrite')
          tx.objectStore('kv').put({ key: 'settings', value: next })
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        }
      })
    })

    // 关 onboarding
    const closeBtn = page.locator('button[aria-label="关闭"]').first()
    if (await closeBtn.isVisible({ timeout: 1500 }).catch(() => false)) await closeBtn.click()

    // 进会议详情（沿用 test 1 的 fast-path）
    await page.getByRole('button', { name: /● 会议/ }).first().click()
    await page.waitForTimeout(200)
    await page.getByRole('button', { name: /● 新建录音/ }).first().click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: /■ 停止/ }).first().click()
    await page.waitForTimeout(800)
    // 停止后自动进入详情页

    await page.getByRole('button', { name: '助手' }).first().click()
    await expect(page.getByText(/还没有索引过的内容/)).toBeVisible({ timeout: 5000 })
  })
})
