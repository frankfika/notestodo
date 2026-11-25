// 临时诊断：定位 CI 上「先点选再拖拽」失败时指针压住了什么
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

test.use({ viewport: { width: 1280, height: 720 } })

test('debug: 点选后拖拽的命中诊断', async ({ page }) => {
  await seed(page)
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
  await topic(page, 'c').waitFor({ state: 'visible', timeout: 15000 })

  await topic(page, 'c').click()
  await expect(page.locator('.mindmap-actionbar')).toBeVisible()
  await page.waitForTimeout(350)

  const diag = await page.evaluate(() => {
    const node = (id: string) => {
      const el = document.querySelector(`.mindmap-canvas [data-mm-node="${id}"]`)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
    }
    const hit = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)
      return el ? `${el.tagName}.${String(el.className).slice(0, 60)}` : 'null'
    }
    const c = node('c')!
    const b = node('b')!
    const bar = document.querySelector('.mindmap-actionbar')?.getBoundingClientRect()
    return {
      c, b,
      bar: bar ? { x: bar.x, y: bar.y, w: bar.width, h: bar.height } : null,
      hitAtC: hit(c.cx, c.cy),
      hitAtB: hit(b.cx, b.cy),
      actionbarBox: null as null,
    }
  })
  console.log(JSON.stringify(diag, null, 2))

  // 真实拖一遍，看手势是否生效
  await page.mouse.move(diag.c.cx, diag.c.cy)
  await page.waitForTimeout(250)
  const c2 = await topic(page, 'c').boundingBox()
  await page.mouse.move(c2!.x + c2!.width / 2, c2!.y + c2!.height / 2)
  await page.mouse.down()
  await page.mouse.move(diag.b.cx, diag.b.cy, { steps: 20 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(800)
  const parent = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    return (await db.todos.get('c'))!.parent_id
  })
  console.log('parent after drag:', parent)
})
