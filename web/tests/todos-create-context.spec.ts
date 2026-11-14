import { expect, test } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function boot(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { setFeature } = await import('/src/lib/features.ts')
    await setFeature('mindmap_tasks', true)
    await db.kv.put({ key: 'onboarding_done_v1', value: true })
    await db.todos.clear()
    await db.tags.clear()
    await db.tagBindings.clear()
    await db.boards.clear()
    const ts = new Date().toISOString()
    const base = {
      kind: 'task',
      scope: null,
      status: 'open',
      source: 'manual',
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
    }
    await db.todos.bulkPut([
      { id: 'inbox', title: 'Inbox', parent_id: null, map_id: 'inbox', ...base },
      { id: 'child-1', title: '已选中的任务', parent_id: 'inbox', map_id: 'inbox', sort_order: 2, ...base },
    ])
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    const store = (window as unknown as { __uiStore?: { getState: () => { goTodos: (todoFocusId?: string) => void } } }).__uiStore
    store?.getState().goTodos('child-1')
  })
  await page.waitForTimeout(500)
}

test('切到列表后，顶部创建不再偷偷沿用脑图里的隐藏选中', async ({ page }) => {
  await boot(page)

  await expect(page.getByText('会加到「已选中的任务」下面')).toBeVisible()
  await page.getByRole('button', { name: '按时间', exact: true }).click()
  await expect(page.getByText('会先放进 Inbox')).toBeVisible()

  await page.locator('input[name="todosQuickAdd"]').fill('列表里新建')
  await page.getByRole('button', { name: '放进 Inbox' }).click()

  await expect.poll(async () => page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const all = await db.todos.toArray()
    const todo = all.find((t: { title: string }) => t.title === '列表里新建')
    return { parent_id: todo?.parent_id ?? null, map_id: todo?.map_id ?? null }
  })).toEqual({ parent_id: 'inbox', map_id: 'inbox' })
})

test('切到看板后，顶部不再出现和下面脱节的全局创建表单', async ({ page }) => {
  await boot(page)

  await page.getByRole('button', { name: '看板', exact: true }).click()
  await expect(page.getByText('看板里直接在列底部加卡片')).toBeVisible()
  await expect(page.locator('input[name="todosQuickAdd"]')).toHaveCount(0)
})

test('在按时间创建后，新任务立刻出现在下面并被高亮', async ({ page }) => {
  await boot(page)

  await page.getByRole('button', { name: '按时间', exact: true }).click()
  await page.locator('input[name="todosQuickAdd"]').fill('刚创建的那条')
  await page.getByRole('button', { name: '放进 Inbox' }).click()

  // 下面要能直接看到这条，而不是让用户自己去找
  const row = page.locator('[data-todo]').filter({ hasText: '刚创建的那条' }).first()
  await expect(row).toBeVisible()
  // 并且被高亮提示「就是这条」
  await expect(row).toHaveClass(/ring-accent/)
})

test('看板里新建的卡片会立刻出现在对应列并被高亮', async ({ page }) => {
  await boot(page)

  await page.getByRole('button', { name: '看板', exact: true }).click()
  const col = page.locator('[data-testid="board-col-待办"] input').last()
  await expect(col).toBeVisible()
  await col.fill('看板新卡片')
  await col.press('Enter')

  const card = page.locator('article').filter({ hasText: '看板新卡片' }).first()
  await expect(card).toBeVisible()
  await expect(card).toHaveClass(/ring-accent/)
})
