/**
 * F-13 · 节点操作栏 + 空图引导（端到端）
 *
 * 痛点：增删节点只能靠背快捷键（Tab / Enter / ⌫），
 * 鼠标用户面对画布无从下手。修复：
 *   - 选中任意节点 → 画布底部浮出操作栏（子节点 / 同级 / 完成 / Today / 删除）
 *   - 空图 → 画布中央直接给「添加第一条任务」按钮
 * 操作栏与键盘共用同一套动作（toggleDone / addToday / removeNode）。
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function seed(page: Page, opts: { empty?: boolean } = {}): Promise<void> {
  await page.goto(BASE)
  await page.evaluate(async ({ empty }) => {
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
    const rows = [{ ...base, id: 'proj', parent_id: null, title: '项目甲', sort_order: -2 }]
    if (!empty) {
      rows.push({ ...base, id: 'a', parent_id: 'proj', title: '定稿需求', sort_order: 1 } as never)
    }
    await db.todos.bulkPut(rows)
  }, opts)
}

async function openMindmap(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.mindmap-canvas .me-tpc').first().waitFor({ state: 'visible', timeout: 15000 })
}

function topic(page: Page, id: string) {
  return page.locator(`.mindmap-canvas .me-tpc[data-nodeid="me${id}"]`)
}

test.describe('F-13 节点操作栏 + 空图引导', () => {
  test('选中节点出现操作栏：加子节点 / 完成 / 删除全程不用键盘', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    const bar = page.locator('.mindmap-actionbar')

    // 选中叶子 a → 操作栏出现，且按钮齐全
    await topic(page, 'a').click()
    await expect(bar).toBeVisible()
    await expect(bar.getByRole('button', { name: /子节点/ })).toBeEnabled()
    await expect(bar.getByRole('button', { name: /同级/ })).toBeEnabled()
    await expect(bar.getByRole('button', { name: /完成/ })).toBeEnabled()
    await expect(bar.getByRole('button', { name: /删除/ })).toBeEnabled()

    // ① 点「＋ 子节点」→ 进入新节点编辑态（操作栏让位）
    await bar.getByRole('button', { name: /子节点/ }).click()
    await page.waitForSelector('#input-box', { timeout: 5000 })
    await expect(bar).toHaveCount(0)
    await page.keyboard.type('第一步')
    await page.keyboard.press('Enter')
    await expect(topic(page, 'a')).toBeVisible()

    // ② a 有了孩子 → 变成结构节点，「完成」按钮禁用
    await topic(page, 'a').click()
    await expect(bar).toBeVisible()
    await expect(bar.getByRole('button', { name: /✓ 完成/ })).toBeDisabled()

    // ③ 选中新叶子「第一步」→ 点「✓ 完成」→ 折进已完成组
    await page.locator('.me-tpc', { hasText: '第一步' }).click()
    await bar.getByRole('button', { name: /✓ 完成/ }).click()
    await expect(page.locator('.me-tpc', { hasText: '已完成' }).first()).toBeVisible()

    // ④ 选中 a → 点「删除」→ 整棵子树从画布消失（DB 软删）
    await topic(page, 'a').click()
    await bar.getByRole('button', { name: /删除/ }).click()
    await expect(topic(page, 'a')).toHaveCount(0)
    const deleted = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const t = (await db.todos.get('a'))!
      return { deleted: t.deleted_at !== null, status: t.status }
    })
    expect(deleted.deleted).toBe(true)
    expect(deleted.status).toBe('open') // 删除不篡改 status

    // ⑤ 选中根节点 → 同级 / 删除禁用，子节点可用
    await topic(page, 'proj').click()
    await expect(bar.getByRole('button', { name: /同级/ })).toBeDisabled()
    await expect(bar.getByRole('button', { name: /删除/ })).toBeDisabled()
    await expect(bar.getByRole('button', { name: /子节点/ })).toBeEnabled()
  })

  test('空图：中央引导按钮一键加第一条任务', async ({ page }) => {
    await seed(page, { empty: true })
    await openMindmap(page)

    const hint = page.locator('.mindmap-empty')
    await expect(hint).toBeVisible()
    await hint.getByRole('button', { name: '＋ 添加第一条任务' }).click()

    // 直接进入新节点编辑态，打字即写标题
    await page.waitForSelector('#input-box', { timeout: 5000 })
    await page.keyboard.type('第一件事')
    await page.keyboard.press('Enter')
    await expect(page.locator('.me-tpc', { hasText: '第一件事' })).toBeVisible()
    // 有内容后引导消失
    await expect(hint).toHaveCount(0)
  })
})
