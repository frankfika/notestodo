/**
 * 任务树交互 e2e（当前 UI）：原生 HTML5 拖拽挂载 + ⋯ 菜单「移到根级」。
 * 旧的 dnd-kit 富交互（缩进投影 / 同级拖拽排序 / 上移菜单）已随 UI 简化移除，不再测。
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
      { id: 'p1', kind: 'task', scope: null, parent_id: null, title: '父任务', sort_order: 10, ...base },
      { id: 'c1', kind: 'task', scope: null, parent_id: null, title: '收件箱任务', sort_order: 20, ...base },
    ])
  })
  await page.evaluate(() => (window as unknown as { __uiStore: { getState: () => { goTodos: () => void } } }).__uiStore.getState().goTodos())
  await expect(page.locator('[data-todo="p1"]')).toBeVisible()
  await expect(page.locator('[data-todo="c1"]')).toBeVisible()
}

const parentOf = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    const { db } = await import('/src/db/db.ts')
    return (await db.todos.get(id))?.parent_id ?? null
  }, id)

test('拖拽：把任务拖到另一个任务上 = 挂为它的子任务；非法落点（自身）不动', async ({ page }) => {
  await seed(page)

  // 原生 HTML5 DnD：dispatchEvent 序列（Playwright 鼠标拖拽对原生 draggable 不可靠）
  // dragId 是 React state，dispatch 之间要让出事件循环让它 flush
  const html5Drag = async (from: string, to: string) => page.evaluate(async ({ from, to }) => {
    const dt = new DataTransfer()
    const src = document.querySelector(`[data-todo="${from}"]`)!
    const dst = document.querySelector(`[data-todo="${to}"]`)!
    const tick = () => new Promise((r) => setTimeout(r, 50))
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    await tick()
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await tick()
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
  }, { from, to })
  await html5Drag('c1', 'p1')
  await expect.poll(() => parentOf(page, 'c1')).toBe('p1')

  // 拖到自己上 = 不动
  await html5Drag('c1', 'c1')
  await page.waitForTimeout(300)
  expect(await parentOf(page, 'c1')).toBe('p1')
})

test('子树进度徽标：父任务行显示「已完成/子任务总数」（子树计数改成建树时一次算完）', async ({ page }) => {
  await seed(page)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const ts = new Date().toISOString()
    const base = { status: 'open', source: 'manual', notes_md: '', created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 }
    await db.todos.bulkPut([
      { id: 'k1', kind: 'task', scope: null, parent_id: 'p1', title: '子一', sort_order: 1, ...base },
      { id: 'k2', kind: 'task', scope: null, parent_id: 'p1', title: '子二', sort_order: 2, ...base },
      { id: 'k3', kind: 'task', scope: null, parent_id: 'p1', title: '子三', sort_order: 3, ...base, status: 'done' },
    ])
  })
  await page.reload()
  await page.evaluate(() => (window as unknown as { __uiStore: { getState: () => { goTodos: () => void } } }).__uiStore.getState().goTodos())
  await expect(page.locator('[data-todo="p1"]')).toBeVisible()

  // 切「全部」——默认「进行中」会把已完成的子任务整棵滤掉，徽标分母只剩未完成的
  await page.getByRole('button', { name: '全部', exact: true }).click()
  // 父任务自身不计入分母：3 个子任务、1 个已完成 → 1/3
  await expect(page.locator('[data-todo="p1"]')).toContainText('1/3')
})

test('⋯ 菜单「移到根级」= 取消挂载', async ({ page }) => {
  await seed(page)
  // 先挂进去
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.todos.update('c1', { parent_id: 'p1' })
  })
  await page.reload()
  await page.evaluate(() => (window as unknown as { __uiStore: { getState: () => { goTodos: () => void } } }).__uiStore.getState().goTodos())
  await expect(page.locator('[data-todo="c1"]')).toBeVisible()

  await page.locator('[data-todo="c1"]').hover()
  await page.locator('[data-todo="c1"] button[title="更多操作"]').click()
  await page.getByRole('button', { name: '移到根级' }).click()
  await expect.poll(() => parentOf(page, 'c1')).toBe(null)
})
