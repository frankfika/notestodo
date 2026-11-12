/**
 * F-14 · 画布拖拽换父级（端到端）
 *
 * ME6 自带指针拖拽（拖到节点上 = 成为子节点，拖到上/下缘 = 排前/排后），
 * drop 时走 moveNodesIn/Before/After → 我们的 operation 监听写回 Dexie。
 * 本用例确认这条链路真的通：拖 c（a 的孩子）到 b 上 → c 变成 b 的孩子。
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
  return page.locator(`.mindmap-canvas .me-tpc[data-nodeid="me${id}"]`)
}

test('拖拽节点到另一节点上 → 成为其子节点并落库', async ({ page }) => {
  await seed(page)
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
  await topic(page, 'c').waitFor({ state: 'visible', timeout: 15000 })

  const from = await topic(page, 'c').boundingBox()
  const to = await topic(page, 'b').boundingBox()
  expect(from && to).toBeTruthy()

  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  // 分多步移动，让 ME 的指针拖拽识别 + 落点预览生效
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
