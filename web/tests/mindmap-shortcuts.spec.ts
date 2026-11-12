/**
 * F-02 · 脑图快捷键语义（端到端）
 *
 * 之前 F-02 只做了 200 节点 convert 烟测，快捷键语义靠单测覆盖，
 * 但「真的按下去会发生什么」没有端到端验证。这里在真实画布上按键盘。
 *
 * 覆盖：Tab（新增子节点）/ Enter（新增兄弟节点）/ ⇧Tab（提升）/
 *       ⌥Tab（降低）/ ⌘Enter（编辑）/ Delete（删除）/ Space（叶子完成，
 *       非叶子无效并给提示）/ ⌘T（入 Today，非叶子 / Waiting 拦截）/
 *       ⌘]（切图）/ 快捷键面板可发现。
 *
 * 快捷键表与实现同源：见 src/pages/todos/MindmapCanvas.tsx 的 SHORTCUT_ROWS。
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** 一张图：根 → a / b（同级）/ c（a 的孩子）；另有一个 Waiting 叶子 */
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
      // sort_order 取负值：保证排在系统 Inbox（sort_order 0）之前，默认打开的是本图
      { ...base, id: 'proj', parent_id: null, title: '项目甲', map_id: 'proj', sort_order: -2 },
      { ...base, id: 'proj2', parent_id: null, title: '项目乙', map_id: 'proj2', sort_order: -1 },
      { ...base, id: 'a', parent_id: 'proj', title: '定稿需求', map_id: 'proj', sort_order: 1 },
      { ...base, id: 'b', parent_id: 'proj', title: '联调接口', map_id: 'proj', sort_order: 2 },
      { ...base, id: 'c', parent_id: 'a', title: '写 PRD', map_id: 'proj', sort_order: 1 },
      {
        ...base,
        id: 'wait',
        parent_id: 'proj',
        title: '等回复',
        map_id: 'proj',
        sort_order: 3,
        waiting_reason: '等对方邮件',
      },
    ])
  })
}

/** 进任务页 → 脑图 Tab（flag 开启时默认） */
async function openMindmap(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
  await page.locator('.mindmap-canvas .me-tpc').first().waitFor({ state: 'visible', timeout: 15000 })
}

function topic(page: Page, id: string) {
  // ME 给节点加 data-nodeid="me<id>"
  return page.locator(`.mindmap-canvas .me-tpc[data-nodeid="me${id}"]`)
}

async function todoOf(page: Page, id: string): Promise<{
  parent_id: string | null
  status: string
  title: string
  deleted_at: string | null
} | null> {
  return page.evaluate(async (tid) => {
    const { db } = await import('/src/db/db.ts')
    const t = await db.todos.get(tid)
    return t
      ? { parent_id: t.parent_id, status: t.status, title: t.title, deleted_at: t.deleted_at }
      : null
  }, id)
}

async function childIds(page: Page, parentId: string): Promise<string[]> {
  return page.evaluate(async (pid) => {
    const { db } = await import('/src/db/db.ts')
    const rows = await db.todos.where('parent_id').equals(pid).toArray()
    return rows.filter((r) => r.deleted_at === null).map((r) => r.id)
  }, parentId)
}

async function slotIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { getToday } = await import('/src/lib/mindmap/todaySlots.ts')
    return (await getToday()).slots.map((s) => s.leafId)
  })
}

test.describe('F-02 脑图快捷键语义', () => {
  test.beforeEach(async ({ page }) => {
    await seed(page)
    await openMindmap(page)
  })

  test('Tab：新增子节点（挂在选中节点下）', async ({ page }) => {
    // seed 里 'c' 本来就是 'a' 的孩子，所以基线长度是 1，不是 0
    const before = await childIds(page, 'a')
    await topic(page, 'a').click()
    await page.keyboard.press('Tab')
    await expect.poll(() => childIds(page, 'a')).toHaveLength(before.length + 1)
  })

  test('Enter：新增兄弟节点（同一父下）', async ({ page }) => {
    await topic(page, 'a').click()
    await page.keyboard.press('Enter')
    await expect.poll(() => childIds(page, 'proj')).toHaveLength(4)
  })

  test('⇧Tab：提升一级（变成父节点的兄弟）', async ({ page }) => {
    await topic(page, 'c').click()
    await page.keyboard.press('Shift+Tab')
    await expect.poll(async () => (await todoOf(page, 'c'))?.parent_id).toBe('proj')
  })

  test('⌥Tab：降低一级（挂到上一个同级下）', async ({ page }) => {
    await topic(page, 'b').click()
    await page.keyboard.press('Alt+Tab')
    await expect.poll(async () => (await todoOf(page, 'b'))?.parent_id).toBe('a')
  })

  test('⌘Enter：进入编辑（画布内出现输入框）', async ({ page }) => {
    await topic(page, 'a').click()
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(page.locator('.mindmap-canvas #input-box')).toBeVisible()
  })

  test('Delete：删除节点（软删，可 ⌘Z 撤销）', async ({ page }) => {
    await topic(page, 'c').click()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await todoOf(page, 'c'))?.deleted_at).not.toBeNull()

    await page.keyboard.press(`${MOD}+z`)
    await expect.poll(async () => (await todoOf(page, 'c'))?.deleted_at).toBeNull()
  })

  test('Space：叶子可完成，⌘Z 可撤销', async ({ page }) => {
    await topic(page, 'b').click()
    await page.keyboard.press('Space')
    await expect.poll(async () => (await todoOf(page, 'b'))?.status).toBe('done')

    await page.keyboard.press(`${MOD}+z`)
    await expect.poll(async () => (await todoOf(page, 'b'))?.status).toBe('open')
  })

  test('Space：非叶子无效并给出可教提示（R1）', async ({ page }) => {
    await topic(page, 'a').click()
    await page.keyboard.press('Space')
    await expect(page.locator('.mindmap-coach')).toBeVisible()
    await expect(page.locator('.mindmap-coach')).toContainText('拆')
    expect((await todoOf(page, 'a'))?.status).toBe('open')
  })

  test('Space：编辑节点标题时不触发完成', async ({ page }) => {
    await topic(page, 'b').dblclick()
    await expect(page.locator('.mindmap-canvas #input-box')).toBeVisible()
    await page.keyboard.press('Space')
    await page.waitForTimeout(300)
    expect((await todoOf(page, 'b'))?.status).toBe('open')
  })

  test('⌘T：叶子入 Today，⌘Z 可撤销入槽', async ({ page }) => {
    await topic(page, 'b').click()
    await page.keyboard.press(`${MOD}+t`)
    await expect.poll(() => slotIds(page)).toContain('b')

    await page.keyboard.press(`${MOD}+z`)
    await expect.poll(() => slotIds(page)).not.toContain('b')
  })

  test('⌘T：非叶子给教练提示，不入槽', async ({ page }) => {
    await topic(page, 'a').click()
    await page.keyboard.press(`${MOD}+t`)
    await expect(page.locator('.mindmap-coach')).toBeVisible()
    await expect(page.locator('.mindmap-coach')).toContainText('拆')
    expect(await slotIds(page)).not.toContain('a')
  })

  test('⌘T：Waiting 节点被拦截并说明原因', async ({ page }) => {
    await topic(page, 'wait').click()
    await page.keyboard.press(`${MOD}+t`)
    await expect(page.locator('.mindmap-coach')).toBeVisible()
    await expect(page.locator('.mindmap-coach')).toContainText('Waiting')
    expect(await slotIds(page)).not.toContain('wait')
  })

  test('⌥↑ / ⌥↓：同级上移 / 下移一位（不换父级）', async ({ page }) => {
    // b 初始在 a 之后（sort_order 2 > 1）
    await topic(page, 'b').click()
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(async () => {
      const sibs = await page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts')
        return (await db.todos.toArray())
          .filter((t) => t.parent_id === 'proj' && !t.deleted_at)
          .sort((x, y) => x.sort_order - y.sort_order)
          .map((t) => t.id)
      })
      return sibs.indexOf('b') < sibs.indexOf('a')
    }).toBe(true)
    // 父级不变
    expect((await todoOf(page, 'b'))?.parent_id).toBe('proj')

    // 再按 ⌥↓ 移回去
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(async () => {
      const sibs = await page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts')
        return (await db.todos.toArray())
          .filter((t) => t.parent_id === 'proj' && !t.deleted_at)
          .sort((x, y) => x.sort_order - y.sort_order)
          .map((t) => t.id)
      })
      return sibs.indexOf('b') > sibs.indexOf('a')
    }).toBe(true)
  })

  test('⌘]：切到下一张图', async ({ page }) => {
    await topic(page, 'a').click()
    await page.keyboard.press(`${MOD}+]`)
    await expect(topic(page, 'proj2')).toBeVisible({ timeout: 10000 })
  })

  test('快捷键可发现：角标点开即清单，且没有巨型工具条', async ({ page }) => {
    await expect(page.locator('.mindmap-hint-btn')).toBeVisible()
    await page.locator('.mindmap-hint-btn').click()
    const panel = page.locator('.mindmap-hint-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('新增子节点')
    await expect(panel).toContainText('加入 Today')
    // 仅叶子规则在提示里可见可教（R1）
    await expect(panel).toContainText('仅叶子')
    // 画布上没有 ME 工具条 / 常驻右键菜单
    await expect(page.locator('.mind-elixir-toolbar')).toHaveCount(0)
    await expect(page.locator('.context-menu')).toHaveCount(0)
  })
})
