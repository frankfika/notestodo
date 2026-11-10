/**
 * F-09 · Apple 极简视觉走查（自动化）
 *
 * 之前 F-09 只做到「写了 mindmap.css + 没有巨型工具条」，
 * 没有可执行的走查清单。这里把「极简」拆成能断言的几条：
 * 无 ME 工具条 / 无常驻右键菜单 / 节点是纯文字不是盒子 /
 * 画布跟着应用令牌走（暗色不塌成白底）/ 教练提示是非模态浮层。
 * 末尾截图存 tests/screenshots/ 供人工 HIG 复核。
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
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
    }
    await db.todos.bulkPut([
      { ...base, id: 'proj', parent_id: null, title: '发布 v1.0', map_id: 'proj' },
      { ...base, id: 'a', parent_id: 'proj', title: '定稿需求', map_id: 'proj', due_date: '2026-11-12' },
      { ...base, id: 'b', parent_id: 'proj', title: '联调接口', map_id: 'proj' },
      { ...base, id: 'c', parent_id: 'a', title: '写 PRD', map_id: 'proj' },
      { ...base, id: 'd', parent_id: 'a', title: '评审', map_id: 'proj', waiting_reason: '等设计稿' },
    ])
  })
}

async function openMindmap(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.mindmap-canvas .me-tpc').first().waitFor({ state: 'visible', timeout: 15000 })
}

test.describe('F-09 脑图视觉走查', () => {
  test.beforeEach(async ({ page }) => {
    await seed(page)
    await openMindmap(page)
  })

  test('无 ME 工具条 / 无常驻右键菜单（不靠巨型工具条做操作）', async ({ page }) => {
    await expect(page.locator('.mind-elixir-toolbar')).toHaveCount(0)
    await expect(page.locator('.context-menu')).toHaveCount(0)
  })

  test('节点是纯文字而非圆角盒子；字号 14px；继承应用字体', async ({ page }) => {
    const topic = page.locator('.mindmap-canvas .me-tpc[data-nodeid="meproj"]')
    await expect(topic).toBeVisible()

    const style = await topic.evaluate((el) => {
      const cs = getComputedStyle(el)
      return {
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        background: cs.backgroundColor,
        borderTopWidth: cs.borderTopWidth,
      }
    })
    expect(style.fontSize).toBe('14px')
    // 继承应用字体，不是 ME 自带的 system-ui 兜底
    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
    expect(style.fontFamily).toBe(bodyFont)
    // 纯文字：子节点无底色、无边框
    const child = await page
      .locator('.mindmap-canvas .me-tpc[data-nodeid="mea"]')
      .evaluate((el) => {
        const cs = getComputedStyle(el)
        return { background: cs.backgroundColor, border: cs.borderTopWidth }
      })
    expect(child.background).toBe('rgba(0, 0, 0, 0)')
    expect(child.border).toBe('0px')
  })

  test('画布背景跟随应用令牌（暗色不塌成白底）', async ({ page }) => {
    const canvasBg = async (): Promise<string> =>
      page.evaluate(() => getComputedStyle(document.querySelector('.mindmap-canvas')!).backgroundColor)
    const appBg = async (): Promise<string> =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())

    const lightCanvas = await canvasBg()
    expect(lightCanvas).not.toBe('rgb(250, 250, 250)') // 不再是写死的浅灰

    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await page.waitForTimeout(150)
    const darkCanvas = await canvasBg()
    const darkApp = await appBg()
    // 暗色下画布应是应用深色底（不是白/浅灰）
    expect(darkCanvas).not.toBe(lightCanvas)
    expect(darkCanvas).not.toBe('rgb(255, 255, 255)')
    expect(darkApp).not.toBe('')
  })

  test('教练提示是非模态浮层（不遮挡、不抢焦点）', async ({ page }) => {
    await page.locator('.mindmap-canvas .me-tpc[data-nodeid="meproj"]').click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+t' : 'Control+t')
    const coach = page.locator('.mindmap-coach')
    await expect(coach).toBeVisible()
    await expect(coach).toHaveAttribute('role', 'status')

    const style = await coach.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { pointerEvents: cs.pointerEvents, position: cs.position }
    })
    expect(style.pointerEvents).toBe('none')
    expect(style.position).toBe('absolute')
    // 没有全屏遮罩（CommandPalette / 速查卡那类 fixed inset-0 覆盖层）
    await expect(page.locator('div.fixed.inset-0')).toHaveCount(0)
  })

  test('截图存档（人工 HIG 复核用）', async ({ page }) => {
    await page.locator('.mindmap-canvas .me-tpc[data-nodeid="meproj"]').click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'tests/screenshots/visual-mindmap.png', fullPage: false })
  })
})
