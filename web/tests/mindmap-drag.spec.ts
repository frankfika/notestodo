/**
 * 自由画布 · 拖拽（端到端）
 *
 * 自绘画布的三条拖拽语义：
 *   拖到空白处 = 自由摆放（pos_x/pos_y 落库，位置记住）；
 *   拖到节点上 = 成为它的子节点；
 *   拖到节点的上 / 下边缘 = 排到它前面 / 后面。
 * 本用例确认这几条链路真的通。
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function seed(page: Page): Promise<void> {
  await page.goto(BASE)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { setFeature } = await import('/src/lib/features.ts')
    await db.kv.put({ key: 'onboarding_done_v1', value: true })
    await db.todos.clear()
    await setFeature('mindmap_tasks', true)
    const ts = new Date().toISOString()
    const base = {
      kind: 'task' as const,
      scope: null,
      status: 'open' as const,
      source: 'manual' as const,
      map_id: 'proj',
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
    }
    await db.todos.bulkPut([
      { ...base, id: 'proj', parent_id: null, title: '项目甲', sort_order: -2 },
      { ...base, id: 'a', parent_id: 'proj', title: '定稿需求', sort_order: 1 },
      { ...base, id: 'b', parent_id: 'proj', title: '联调接口', sort_order: 2 },
      { ...base, id: 'c', parent_id: 'a', title: '写 PRD', sort_order: 1 },
    ])
  })
}

function topic(page: Page, id: string) {
  return page.locator(`.mindmap-canvas [data-mm-node="${id}"]`)
}

test('拖到空白处 = 自由摆放：位置落库并生效', async ({ page }) => {
  await seed(page)
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
  await topic(page, 'c').waitFor({ state: 'visible', timeout: 15000 })

  const from = await topic(page, 'c').boundingBox()
  expect(from).toBeTruthy()
  // 拖到节点下方的空白区（远离其它节点：左边是父级链，别压上去）
  const to = { x: from!.x + 80, y: from!.y + 220 }

  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 16 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(600)

  const pos = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const t = (await db.todos.get('c'))!
    return { x: t.pos_x ?? null, y: t.pos_y ?? null, parent: t.parent_id }
  })
  // 位置写进库里，且结构没变
  expect(typeof pos.x).toBe('number')
  expect(typeof pos.y).toBe('number')
  expect(pos.parent).toBe('a')

  // 画布上节点真的停在拖放的位置（相对拖放点的容差内）
  const box = await topic(page, 'c').boundingBox()
  expect(Math.abs(box!.x + box!.width / 2 - to.x)).toBeLessThan(40)
})

test('拖到另一节点上 → 成为其子节点并落库（位置跟随落点）', async ({ page }) => {
  await seed(page)
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
  await topic(page, 'c').waitFor({ state: 'visible', timeout: 15000 })

  const from = await topic(page, 'c').boundingBox()
  const to = await topic(page, 'b').boundingBox()
  expect(from && to).toBeTruthy()

  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 20 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(800)

  const parent = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    return (await db.todos.get('c'))!.parent_id
  })
  expect(parent).toBe('b')
})

test('首次拖动节点 → 教练浮层教拖拽语义（只弹一次）', async ({ page }) => {
  await seed(page)
  // 在画布 mount 前清掉「已教过」标记
  await page.evaluate(() => localStorage.removeItem('mindmap_free_drag_v1'))
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
  await topic(page, 'c').waitFor({ state: 'visible', timeout: 15000 })

  const coach = page.locator('.mindmap-coach')
  const from = await topic(page, 'c').boundingBox()
  expect(from).toBeTruthy()

  // 第一次拖动（往空白处，不改变结构）：提示出现，且标记已写
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(from!.x + 120, from!.y + 120, { steps: 10 })
  await expect(coach).toContainText('挂到它下面', { timeout: 3000 })
  await page.mouse.up()
  expect(
    await page.evaluate(() => localStorage.getItem('mindmap_free_drag_v1')),
  ).toBe('1')

  // 第二次拖动：不再提示
  await expect(coach).toBeHidden({ timeout: 6000 })
  const c2 = await topic(page, 'c').boundingBox()
  await page.mouse.move(c2!.x + c2!.width / 2, c2!.y + c2!.height / 2)
  await page.mouse.down()
  await page.mouse.move(c2!.x + 120, c2!.y + 60, { steps: 10 })
  await expect(coach).toBeHidden()
  await page.mouse.up()
})

test('先点选再拖拽（真实用户路径）→ 换父级落库，且不弹编辑框', async ({ page }) => {
  await seed(page)
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
  await topic(page, 'c').waitFor({ state: 'visible', timeout: 15000 })

  // 用户自然操作：先单击选中 c，再按住拖走。
  await topic(page, 'c').click()
  await expect(page.locator('.mindmap-actionbar')).toBeVisible()

  const from = await topic(page, 'c').boundingBox()
  const to = await topic(page, 'b').boundingBox()
  expect(from && to).toBeTruthy()

  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 20 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(800)

  const parent = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    return (await db.todos.get('c'))!.parent_id
  })
  expect(parent).toBe('b')
  // 拖拽结束浏览器会在原节点上补发一次 click —— 必须被吞掉，否则一拖就弹编辑框
  await expect(page.locator('[data-testid="mm-editor"]')).toHaveCount(0)
})

test('点选后轻微带出拖拽手势再松手 → 不误进编辑态', async ({ page }) => {
  await seed(page)
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
  await topic(page, 'c').waitFor({ state: 'visible', timeout: 15000 })

  await topic(page, 'c').click()
  await expect(page.locator('.mindmap-actionbar')).toBeVisible()

  const from = await topic(page, 'c').boundingBox()
  expect(from).toBeTruthy()

  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await page.mouse.move(from!.x + from!.width / 2 + 10, from!.y + from!.height / 2 + 2, { steps: 4 })
  await expect(page.locator('.mindmap-wrap')).toHaveClass(/is-dragging/)
  await page.mouse.up()
  await page.waitForTimeout(250)

  await expect(page.locator('.mindmap-wrap')).not.toHaveClass(/is-dragging/)
  await expect(page.locator('[data-testid="mm-editor"]')).toHaveCount(0)
})
