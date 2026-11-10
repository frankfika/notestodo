/**
 * F-09 续 · 脑图 Tab 的「画布优先」布局
 *
 * 覆盖：
 *  ① 画布吃满整宽（图库 / Inbox / Today 不再是常驻面板）
 *  ② 图库浮层：切图、归档仍在
 *  ③ Inbox 浮层：捕获照旧
 *  ④ Today 挪去「今天」页：脑图只留计数入口，槽位跟着走
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
      sort_order: 0,
      map_id: 'proj',
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
    }
    await db.todos.bulkPut([
      { ...base, id: 'proj', parent_id: null, title: '项目甲', map_id: 'proj', sort_order: -2 },
      { ...base, id: 'proj2', parent_id: null, title: '项目乙', map_id: 'proj2', sort_order: -1 },
      { ...base, id: 'a', parent_id: 'proj', title: '定稿需求', map_id: 'proj', sort_order: 1 },
    ])
  })
}

async function openMindmap(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas .me-tpc').first().waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(800)
}

test.describe('脑图布局 · 画布优先', () => {
  test('① 画布吃满整宽，没有常驻的图库 / Inbox / Today 面板', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await seed(page)
    await openMindmap(page)

    const geo = await page.evaluate(() => {
      const c = document.querySelector('.mindmap-canvas')
      const r = c?.getBoundingClientRect()
      return { canvas: Math.round(r?.width ?? 0), vw: window.innerWidth }
    })
    // 之前是 456px（被 232 侧栏 + 176 图库 + 176 Inbox + 240 Today 挤的）
    expect(geo.canvas).toBeGreaterThan(900)
    expect(geo.canvas).toBeGreaterThan(geo.vw * 0.75)

    // 常驻面板没了：Today 托盘不在脑图 Tab 里
    await expect(page.getByText('Today ·')).toHaveCount(0)
    // 入口在
    await expect(page.getByTitle('今天要做的事（⌘T 入槽）')).toBeVisible()
  })

  test('② 图库浮层：能切图', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    await page.getByTitle('切换项目图').click()
    await expect(page.getByRole('button', { name: '项目乙', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '项目乙', exact: true }).click()
    await expect(page.locator('.mindmap-canvas .me-tpc[data-nodeid="meproj2"]')).toBeVisible({ timeout: 10000 })
  })

  test('③ Inbox 浮层：捕获照旧', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    await page.getByTitle('Inbox 捕获').click()
    await page.getByPlaceholder('捕获…').fill('随手记一条')
    await page.getByPlaceholder('捕获…').press('Enter')
    await page.waitForTimeout(800)

    const captured = await page.evaluate(async () => {
      const { listInboxCaptures } = await import('/src/lib/mindmap/inboxCapture.ts')
      return (await listInboxCaptures()).map((t) => t.title)
    })
    expect(captured).toContain('随手记一条')
  })

  test('④ Today 挪去「今天」页：脑图只留计数入口', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    // 脑图里选一个叶子按 ⌘T 入槽
    await page.locator('.mindmap-canvas .me-tpc[data-nodeid="mea"]').click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Control+t')
    await expect(page.getByTitle('今天要做的事（⌘T 入槽）')).toContainText('1/5')

    // 点入口 → 到「今天」页，槽位在那儿
    await page.getByTitle('今天要做的事（⌘T 入槽）').click()
    await expect(page.locator('[data-testid="today-page"]')).toBeVisible()
    await expect(page.getByText('今日清单')).toBeVisible()
    await expect(page.getByRole('button', { name: '定稿需求' })).toBeVisible()
  })
})
