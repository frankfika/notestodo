import { expect, test } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function bootBoard(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.kv.put({ key: 'onboarding_done_v1', value: true })
    await db.todos.clear()
    await db.boards.clear()
    await db.tags.clear()
    await db.tagBindings.clear()
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goBoard: () => void } } }).__uiStore?.getState().goBoard())
  await page.waitForTimeout(700)
}

test('看板默认是任务视图，不再鼓励新建多看板', async ({ page }) => {
  await bootBoard(page)

  await expect(page.getByText('看板只是任务的推进视图').first()).toBeVisible()
  await expect(page.getByRole('button', { name: /新建看板/ })).toHaveCount(0)
})

test('看板卡片支持任务属性：自然语言负责人/日期 + 标签', async ({ page }) => {
  await bootBoard(page)

  const quickAdd = page.locator('[data-testid="board-col-待办"] input').last()
  await expect(quickAdd).toBeVisible()
  await quickAdd.fill('明天 交方案 @张三')
  await quickAdd.press('Enter')

  const card = page.locator('article').filter({ hasText: '交方案' }).first()
  await expect(card).toBeVisible()
  await expect(card.getByText('@张三')).toBeVisible()

  await card.locator('button[title="卡片操作"]').click({ force: true })
  const menu = page.locator('.card').filter({ has: page.getByText('负责人') }).last()
  await menu.getByPlaceholder('加标签…').fill('法务')
  await menu.getByPlaceholder('加标签…').press('Enter')

  await expect(card.getByText('法务', { exact: true })).toBeVisible()

  const todo = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const all = await db.todos.toArray()
    const inbox = all.find((t: { parent_id: string | null; title: string }) => t.parent_id === null && t.title === 'Inbox')
    const todo = all.find((t: { title: string }) => t.title === '交方案')
    return { todo, inboxId: inbox?.id ?? null }
  })
  expect(todo.todo?.assignee).toBe('张三')
  expect(todo.todo?.due_date).toBeTruthy()
  expect(todo.todo?.map_id).toBe(todo.inboxId)
  expect(todo.todo?.parent_id).toBe(todo.inboxId)
})

test('看板支持像 Trello 一样快速筛卡', async ({ page }) => {
  await bootBoard(page)

  const quickAdd = page.locator('[data-testid="board-col-待办"] input').last()
  await quickAdd.fill('明天 交方案 @张三')
  await quickAdd.press('Enter')
  await quickAdd.fill('后天 同步排期')
  await quickAdd.press('Enter')

  const filterInput = page.getByPlaceholder('筛卡片、负责人或标签')
  await expect(filterInput).toBeVisible()

  await filterInput.fill('张三')
  await expect(page.locator('article').filter({ hasText: '交方案' })).toBeVisible()
  await expect(page.locator('article').filter({ hasText: '同步排期' })).toHaveCount(0)

  await filterInput.fill('')
  await page.getByRole('button', { name: /已指派/ }).click()
  await expect(page.locator('article').filter({ hasText: '交方案' })).toBeVisible()
  await expect(page.locator('article').filter({ hasText: '同步排期' })).toHaveCount(0)
})
