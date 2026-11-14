/**
 * 助手入口 e2e —— AI 从首页主区退到辅助层后，仍然能顺手叫出来
 *
 * 验证：
 *   1. 默认落地页是「今天」
 *   2. 首页只保留「助手」辅助入口，不再把 AI 做成主工作区
 *   3. 仍然能打开助手抽屉
 *   4. 未配置 AI 时提问不白屏，给出错误提示
 *   5. 动作层：create_task 走自然语言解析（明天 / @负责人），delete 标记为破坏性
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('落地页是「今天」；首页只保留助手入口，仍能打开抽屉', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  const close = page.locator('button[aria-label="关闭"]').first()
  if (await close.isVisible({ timeout: 1500 }).catch(() => false)) await close.click()

  // 默认落地页 = 今天（先看今天要做什么）
  await expect(page.getByTestId('today-page')).toBeVisible()
  await expect(page.getByText('助手').first()).toBeVisible()
  await expect(page.getByRole('button', { name: '✦ 打开助手' })).toBeVisible()
  await page.getByRole('button', { name: '✦ 打开助手' }).click()
  await expect(page.getByRole('complementary', { name: 'AI 助手' })).toBeVisible()

  // 没配 AI 时提问 → 报错而不是白屏
  await page.getByPlaceholder(/问点什么/).fill('列出本周到期的任务')
  await page.getByPlaceholder(/问点什么/).press('Enter')
  await page.waitForTimeout(1200)
  const body = await page.locator('body').innerText()
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
