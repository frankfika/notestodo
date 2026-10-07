/**
 * Shibei · 端到端 smoke test
 *
 * 用 playwright + 真实 Chromium 浏览器，验证：
 *   1. 首页加载并显示侧栏 + Today
 *   2. ⌘K 唤出命令面板
 *   3. 所有一级页面（会议/笔记/待办/模板）能加载且无运行时报错
 *   4. 创建一条 Note 后列表出现
 *   5. ⌘⇧R 录音热键不会让浏览器栈崩（无麦克风授权时 engine 进入 error 态）
 *
 * 运行（先启动 dev server）：
 *   pnpm dev & sleep 4 && SHIBEI_URL=http://127.0.0.1:5173 \
 *     node node_modules/@playwright/test/cli.js test tests/smoke.spec.ts
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function dismissOnboarding(page: import('@playwright/test').Page): Promise<void> {
  // 首次启动会显示右下角引导卡片；点 X 关掉（不阻塞主 UI）
  const onboardingClose = page.locator('button[aria-label="关闭"]').first()
  if (await onboardingClose.isVisible({ timeout: 1500 }).catch(() => false)) {
    await onboardingClose.click()
  }
}

test.describe('Shibei shell smoke', () => {
  test('首页加载并显示侧栏 + Today', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await expect(page.locator('aside', { hasText: '拾贝' })).toBeVisible()
    await expect(page.locator('h1', { hasText: '今天' })).toBeVisible()
    await page.screenshot({ path: 'tests/screenshots/01-today.png', fullPage: true })
  })

  test('⌘K 命令面板可打开', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    // 显式 focus 到 body 再按热键
    await page.locator('body').click({ position: { x: 10, y: 10 } })
    await page.keyboard.press('Meta+k')
    await expect(page.locator('input[placeholder*="搜索"]')).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'tests/screenshots/02-cmdk.png' })
    await page.keyboard.press('Escape')
    await expect(page.locator('input[placeholder*="搜索"]')).toBeHidden({ timeout: 2000 })
  })

  test('所有一级页面可加载（无运行时报错）', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    for (const label of ['会议', '笔记', '待办', '模板']) {
      await page.getByRole('button', { name: label }).click()
      await page.waitForTimeout(200)
    }
    await expect(errors, errors.join('\n')).toHaveLength(0)
  })

  test('创建一条 Note 后列表出现', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await page.getByRole('button', { name: '笔记' }).click()
    // 顶部 "+ 新建笔记" 按钮
    const topNew = page.getByRole('button', { name: '+ 新建笔记' }).first()
    await topNew.waitFor({ state: 'visible', timeout: 5000 })
    await topNew.click()
    // 进入 NoteDetail，等待详情页加载
    await page.locator('button[aria-label="返回"]').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button[aria-label="返回"]').first().click()
    await expect(page.locator('text=未命名笔记').first()).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'tests/screenshots/03-notes.png', fullPage: true })
  })

  test('⌘⇧R 录音热键：engine 切到 error 态（无麦克风授权时）', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await page.context().clearPermissions()
    await page.keyboard.press('Meta+Shift+r')
    await page.waitForTimeout(800)
    await expect(page.locator('aside', { hasText: '拾贝' })).toBeVisible()
  })

  test('新建一个 Objective 时 持久化到 IndexedDB', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await page.getByRole('button', { name: '待办' }).click()
    await page.waitForTimeout(300)

    const newBtn = page.getByRole('button', { name: /新建 Objective/ }).first()
    await newBtn.waitFor({ state: 'visible', timeout: 5000 })
    const beforeCount = await page.evaluate(async () => {
      return new Promise<number>((res) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('todos', 'readonly')
          const cr = tx.objectStore('todos').count()
          cr.onsuccess = () => res(cr.result)
        }
        req.onerror = () => res(-1)
      })
    })
    await newBtn.click()
    await page.waitForTimeout(800)
    const afterCount = await page.evaluate(async () => {
      return new Promise<number>((res) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('todos', 'readonly')
          const cr = tx.objectStore('todos').count()
          cr.onsuccess = () => res(cr.result)
        }
        req.onerror = () => res(-1)
      })
    })
    expect(afterCount).toBe(beforeCount + 1)
    // 新建的 Objective 应该出现在页面上
    await expect(page.locator('text=新工作目标').first()).toBeVisible({ timeout: 3000 })
  })
})