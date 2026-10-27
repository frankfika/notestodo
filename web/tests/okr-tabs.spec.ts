/**
 * 战略视图分页：每个战略 O 一个 tab，只显示自己这棵树；不属于任何战略 O 的根进「其它」。
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function seed(page: Page): Promise<void> {
  await page.goto(BASE)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.kv.put({ key: 'onboarding_done_v1', value: true })
    await db.todos.clear()
    const ts = new Date().toISOString()
    const base = { status: 'open', source: 'manual', notes_md: '', created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 }
    await db.todos.bulkPut([
      { id: 'O1', kind: 'objective', scope: 'strategic', parent_id: null, title: '产品打磨', sort_order: 10 },
      { id: 'K1', kind: 'kr', scope: 'strategic', parent_id: 'O1', title: '体验对标 Notion', sort_order: 20 },
      { id: 'Q1', kind: 'objective', scope: 'quarterly', parent_id: 'K1', title: 'Q4 拖拽升级', period: '2026-Q4', sort_order: 30 },
      { id: 'O2', kind: 'objective', scope: 'strategic', parent_id: null, title: '商业化', sort_order: 40 },
      { id: 'K2', kind: 'kr', scope: 'strategic', parent_id: 'O2', title: '10 个付费客户', sort_order: 50 },
      { id: 'ORPHAN', kind: 'kr', scope: 'strategic', parent_id: 'missing-parent', title: '孤儿 KR', sort_order: 60 },
    ].map((r) => ({ ...base, ...r })))
    ;(window as unknown as { __uiStore: { getState: () => { goTaskMode: (m: string) => void } } }).__uiStore.getState().goTaskMode('strategy')
  })
  await expect(page.locator('[data-todo-id="K1"]')).toBeVisible()
}

test('战略视图：tab 只显示自己这棵树；孤儿根进「其它」tab', async ({ page }) => {
  await seed(page)

  // 两个战略 O → 出现 tab 条；默认选中第一个
  await expect(page.getByRole('tab', { name: '产品打磨' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '商业化' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '其它' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '产品打磨' })).toHaveAttribute('aria-selected', 'true')
  // 第一个 tab 只显示 O1 这棵树
  await expect(page.locator('[data-todo-id="K1"]')).toBeVisible()
  await expect(page.locator('[data-todo-id="K2"]')).toBeHidden()

  // 切到第二个 tab：K1 隐藏、K2 显示；切回仍有（面板只是 hidden，状态保留）
  await page.getByRole('tab', { name: '商业化' }).click()
  await expect(page.getByRole('tab', { name: '商业化' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-todo-id="K2"]')).toBeVisible()
  await expect(page.locator('[data-todo-id="K1"]')).toBeHidden()

  // 「其它」tab：孤儿 KR 可见，两个 O 不可见
  await page.getByRole('tab', { name: '其它' }).click()
  await expect(page.locator('[data-todo-id="ORPHAN"]')).toBeVisible()
  await expect(page.locator('[data-todo-id="O1"]')).toBeHidden()

  // 切回第一个 tab，树还在
  await page.getByRole('tab', { name: '产品打磨' }).click()
  await expect(page.locator('[data-todo-id="Q1"]')).toBeVisible()
})
