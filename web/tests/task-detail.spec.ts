import { expect, test, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function seed(page: Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { setFeature } = await import('/src/lib/features.ts')
    await db.kv.put({ key: 'onboarding_done_v1', value: true })
    await db.todos.clear()
    await db.boards.clear()
    await db.tagBindings.clear()
    await db.tags.clear()
    await setFeature('mindmap_tasks', true)
    const ts = new Date().toISOString()
    await db.todos.bulkPut([
      {
        id: 'proj',
        kind: 'task',
        scope: null,
        parent_id: null,
        title: '项目甲',
        status: 'open',
        source: 'manual',
        sort_order: 0,
        map_id: 'proj',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      },
      {
        id: 'task-a',
        kind: 'task',
        scope: null,
        parent_id: 'proj',
        title: '准备方案',
        status: 'open',
        source: 'manual',
        board_col: '待办',
        sort_order: 10,
        map_id: 'proj',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      },
    ])
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
}

test('任务详情抽屉能保存具体时间、备注和负责人', async ({ page }) => {
  await seed(page)

  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.getByRole('button', { name: '按时间' }).click()
  await page.locator('[data-todo="task-a"]').waitFor({ state: 'visible', timeout: 15000 })

  await page.locator('[data-todo="task-a"]').getByTitle('更多操作').click()
  await page.getByRole('button', { name: '打开详情' }).click()

  const drawer = page.getByLabel('任务详情')
  await expect(drawer).toBeVisible()

  await drawer.locator('input[type="date"]').fill('2026-11-20')
  await drawer.locator('input[type="time"]').fill('15:30')
  await drawer.getByPlaceholder('写下补充说明、上下文、风险点或交付口径…').fill('先和法务确认口径，再发给客户。')
  await drawer.getByPlaceholder('写下补充说明、上下文、风险点或交付口径…').blur()
  await drawer.getByTitle('关联人').click()
  await page.locator('button[data-person-name="李娜"]').click()

  const todo = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    return await db.todos.get('task-a')
  })
  expect(todo?.due_date).toBe('2026-11-20')
  expect(todo?.due_time).toBe('15:30')
  expect(todo?.notes_md).toBe('先和法务确认口径，再发给客户。')
  expect(todo?.assignee).toBe('李娜')

  await expect(page.locator('[data-todo="task-a"]')).toContainText('11/20 15:30')
  await expect(page.locator('[data-todo="task-a"]')).toContainText('@李娜')
})

test('看板卡片可直接打开任务详情抽屉', async ({ page }) => {
  await seed(page)

  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goBoard: () => void } } }).__uiStore?.getState().goBoard())
  await page.waitForTimeout(800)

  const card = page.locator('article').filter({ hasText: '准备方案' }).first()
  await expect(card).toBeVisible()
  await card.click()

  const drawer = page.getByLabel('任务详情')
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('input[value="准备方案"]').first()).toBeVisible()
})
