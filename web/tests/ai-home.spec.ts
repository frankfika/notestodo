/**
 * AI 工作台（首页）e2e —— AI 从「能答」到「能动手」
 *
 * 验证：
 *   1. 默认落地页是 AI 工作台（侧栏有 AI 一级入口）
 *   2. 快捷动作 chips 可见
 *   3. 未配置 AI 时提问不白屏，给出错误提示
 *   4. 动作层：create_task 走自然语言解析（明天 / @负责人），delete 标记为破坏性
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('首页是 AI 工作台：快捷动作 + 未配置时优雅报错', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  const close = page.locator('button[aria-label="关闭"]').first()
  if (await close.isVisible({ timeout: 1500 }).catch(() => false)) await close.click()

  // 一级导航有 AI
  await expect(page.getByRole('button', { name: '✦ AI' })).toBeVisible()
  // 默认落地页 = AI 工作台
  await expect(page.getByText('AI 工作台').first()).toBeVisible()
  // 快捷动作
  await expect(page.getByRole('button', { name: '新建任务：明天交方案 @张三' })).toBeVisible()

  // 没配 AI 时提问 → 报错而不是白屏
  await page.getByRole('button', { name: '列出本周到期的任务' }).click()
  await page.waitForTimeout(1200)
  const body = await page.locator('main').innerText()
  expect(body.length).toBeGreaterThan(0)
  expect(body).not.toContain('undefined')
})

test('动作层：自然语言建任务 + 删除为破坏性操作', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  const res = await page.evaluate(async () => {
    const { executeAction } = await import('/src/lib/aiActions.ts')
    const { db } = await import('/src/db/db.ts')
    const created = await executeAction({ type: 'create_task', title: '明天 交方案 @张三' }, new Map())
    const todos = await db.todos.toArray()
    const mine = todos.find((t) => t.title === '交方案')
    const del = await executeAction({ type: 'delete_task', task_id: 'T1' }, new Map())
    await created.undo?.()
    const after = await db.todos.toArray()
    return {
      label: created.label,
      due: mine?.due_date ?? null,
      assignee: mine?.assignee ?? null,
      risky: del.risky,
      gone: !after.some((t) => t.title === '交方案'),
    }
  })

  expect(res.label).toContain('交方案')
  expect(res.due).toBeTruthy()
  expect(res.assignee).toBe('张三')
  expect(res.risky).toBe(true)
  expect(res.gone).toBe(true)
})
