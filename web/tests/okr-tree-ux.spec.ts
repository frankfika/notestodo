/**
 * OKR 树交互：拖拽挂到 KR / 同级排序 / 非法落点被拒 / ⋯ 菜单上移 / 拖回 Inbox。
 * 拖拽基于 dnd-kit（PointerSensor + ⠿ 手柄），合成事件用 PointerEvent，真实拖拽走 page.mouse。
 */
import { test, expect, type Page, type Locator } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

/** Playwright 的真实鼠标拖拽偶发挂住，所以排序 / 非法落点用合成 PointerEvent（dnd-kit 监听 pointer*） */
async function synthDrag(page: Page, fromId: string, toId: string, fy: number): Promise<void> {
  await page.evaluate(async ({ fromId, toId, fy }) => {
    const handle = (id: string) => document.querySelector(`[data-todo-id="${id}"] [aria-label="拖动调整位置"]`) as HTMLElement
    const rowOf = (id: string) => document.querySelector(`[data-todo-id="${id}"] > div`) as HTMLElement
    const fire = (el: Element, type: string, x: number, y: number, up = false) =>
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
        button: 0, buttons: up ? 0 : 1, clientX: x, clientY: y,
      }))
    const h = handle(fromId)
    const hr = h.getBoundingClientRect()
    const sx = hr.left + hr.width / 2
    const sy = hr.top + hr.height / 2
    fire(h, 'pointerdown', sx, sy)
    await new Promise((r) => setTimeout(r, 50))
    fire(document, 'pointermove', sx, sy + 10) // 越过 6px 死区
    await new Promise((r) => setTimeout(r, 50))
    const tr = rowOf(toId).getBoundingClientRect()
    const tx = tr.left + tr.width / 2
    const ty = tr.top + Math.min(Math.max(tr.height * fy, 2), tr.height - 2)
    fire(document, 'pointermove', tx, ty)
    await new Promise((r) => setTimeout(r, 50))
    fire(document, 'pointerup', tx, ty, true)
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

const row = (page: Page, id: string) => page.locator(`[data-todo-id="${id}"] > div`).first()
const handle = (page: Page, id: string) => page.locator(`[data-todo-id="${id}"] [aria-label="拖动调整位置"]`).first()

/** 用真实鼠标步骤拖拽（从 ⠿ 手柄按下 → 分步移动 → 松开），fy = 目标内纵向比例（0 顶 / 0.5 中 / 1 底） */
async function drag(page: Page, from: Locator, to: Locator, fy = 0.5): Promise<void> {
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
  await drag(page, handle(page, 'in'), row(page, 'QK'), 0.5)
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
  await drag(page, handle(page, 't1'), page.locator('section', { hasText: 'Inbox' }).first(), 0.5)
  await expect.poll(async () => (await get(page, 't1'))?.parent_id).toBeNull()
})
