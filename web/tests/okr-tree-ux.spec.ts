/**
 * OKR 树交互：拖拽挂到 KR / 同级排序 / 非法落点被拒 / ⋯ 菜单上移 / 拖回 Inbox。
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

/**
 * Playwright 的鼠标拖拽模拟在同一页第二次拖拽时会挂住（与应用无关：同样的拖拽用真实 DragEvent 派发 ~30ms 完成）。
 * 所以：每次真实鼠标拖拽后重载页面（数据在 IndexedDB 里）；排序 / 非法落点用 synthDrag 直接派发 DragEvent。
 */
async function synthDrag(page: Page, fromId: string, toId: string, fy: number): Promise<void> {
  await page.evaluate(async ({ fromId, toId, fy }) => {
    const row = (id: string) => document.querySelector(`[data-todo-id="${id}"] > div[draggable]`) as HTMLElement
    const dt = new DataTransfer()
    const fire = (el: HTMLElement, type: string) => {
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + Math.max(2, r.height * fy) }))
    }
    fire(row(fromId), 'dragstart')
    await new Promise((r) => setTimeout(r, 50))
    fire(row(toId), 'dragover')
    await new Promise((r) => setTimeout(r, 50))
    fire(row(toId), 'drop')
    fire(row(fromId), 'dragend')
  }, { fromId, toId, fy })
}

async function reopen(page: Page): Promise<void> {
  await page.reload()
  await page.evaluate(() => (window as unknown as { __uiStore: { getState: () => { goTaskMode: (m: string) => void } } }).__uiStore.getState().goTaskMode('strategy'))
  await expect(page.locator('[data-todo-id="t1"]')).toBeVisible()
}

async function seed(page: Page): Promise<void> {
  await page.goto(BASE)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.kv.put({ key: 'onboarding_done_v1', value: true })
    await db.todos.clear()
    const ts = new Date().toISOString()
    const base = { status: 'open', source: 'manual', notes_md: '', created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 }
    const rows = [
      { id: 'O', kind: 'objective', scope: 'strategic', parent_id: null, title: '战略目标甲', sort_order: 10 },
      { id: 'KR', kind: 'kr', scope: 'strategic', parent_id: 'O', title: '战略 KR 乙', sort_order: 20 },
      { id: 'QO', kind: 'objective', scope: 'quarterly', parent_id: 'KR', title: '季度目标丙', period: '2026-Q4', sort_order: 30 },
      { id: 'QK', kind: 'kr', scope: 'quarterly', parent_id: 'QO', title: '季度 KR 丁', period: '2026-Q4', sort_order: 40 },
      { id: 't1', kind: 'task', scope: 'quarterly', parent_id: 'QK', title: '任务一', sort_order: 10 },
      { id: 't2', kind: 'task', scope: 'quarterly', parent_id: 'QK', title: '任务二', sort_order: 20 },
      { id: 't3', kind: 'task', scope: 'quarterly', parent_id: 'QK', title: '任务三', sort_order: 30 },
      { id: 'in', kind: 'task', scope: null, parent_id: null, title: '收件箱任务', sort_order: 10 },
    ]
    await db.todos.bulkPut(rows.map((r) => ({ ...base, ...r })) as never)
    ;(window as unknown as { __uiStore: { getState: () => { goTaskMode: (m: string) => void } } }).__uiStore.getState().goTaskMode('strategy')
  })
  await expect(page.locator('[data-todo-id="t3"]')).toBeVisible()
}

const row = (page: Page, id: string) => page.locator(`[data-todo-id="${id}"] > div[draggable]`).first()

/** 用真实鼠标步骤拖拽（按下 → 分步移动 → 松开），fy = 目标内纵向比例（0 顶 / 0.5 中 / 1 底） */
async function drag(page: Page, from: ReturnType<typeof row>, to: ReturnType<typeof row>, fy = 0.5): Promise<void> {
  const a = (await from.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  const b = (await to.boundingBox())!
  const y = b.y + Math.min(Math.max(b.height * fy, 2), b.height - 2)
  await page.mouse.move(b.x + b.width / 2, y, { steps: 12 })
  await page.mouse.up()
}
const get = (page: Page, id: string) => page.evaluate(async (id) => {
  const { db } = await import('/src/db/db.ts')
  return db.todos.get(id)
}, id)
const order = (page: Page) => page.evaluate(async () => {
  const { db } = await import('/src/db/db.ts')
  return (await db.todos.where('parent_id').equals('QK').toArray()).sort((a, b) => a.sort_order - b.sort_order).map((t) => t.id)
})

test('拖拽：Inbox 任务拖到 KR 上 = 挂进去；同级拖到最前 = 排序；非法落点不生效', async ({ page }) => {
  await seed(page)

  // 1) 收件箱任务拖到「季度 KR 丁」行中间 → 挂到它下面，scope 跟随
  await drag(page, row(page, 'in'), row(page, 'QK'), 0.5)
  await expect.poll(async () => (await get(page, 'in'))?.parent_id).toBe('QK')
  expect((await get(page, 'in'))?.scope).toBe('quarterly')
  await reopen(page)

  // 2) 任务三拖到任务一的上沿 → 排到最前
  await synthDrag(page, 't3', 't1', 0)
  await expect.poll(() => order(page)).toEqual(['t3', 't1', 't2', 'in'])

  // 3) 季度 O 拖到任务上（中间）→ 非法，不变
  await synthDrag(page, 'QO', 't1', 0.5)
  await page.waitForTimeout(300)
  expect((await get(page, 'QO'))?.parent_id).toBe('KR')
})

test('⋯ 菜单上移；拖回 Inbox = 取消挂载', async ({ page }) => {
  await seed(page)
  const more = page.locator('[data-todo-id="t2"]').getByRole('button', { name: '更多操作' }).first()
  await page.locator('[data-todo-id="t2"]').hover()
  await more.click()
  await page.getByRole('menuitem', { name: '上移' }).click()
  await expect.poll(() => order(page)).toEqual(['t2', 't1', 't3'])
  await reopen(page)

  // 收件箱有任务时 Inbox 区块就在顶部：把任务一拖进去
  await drag(page, row(page, 't1'), page.locator('section', { hasText: 'Inbox' }).first(), 0.5)
  await expect.poll(async () => (await get(page, 't1'))?.parent_id).toBeNull()
})
