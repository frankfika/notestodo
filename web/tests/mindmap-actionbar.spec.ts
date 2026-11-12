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
    await expect(bar.getByRole('button', { name: /上移/ })).toBeVisible()
    await expect(bar.getByRole('button', { name: /下移/ })).toBeVisible()
    await expect(bar.getByRole('button', { name: /删除/ })).toBeEnabled()
    await expect(page.getByRole('button', { name: '适应画布' })).toBeVisible()

    // ① 点「＋ 子节点」→ 进入新节点编辑态（操作栏让位）
    await bar.getByRole('button', { name: /子节点/ }).click()
    await page.waitForSelector('#input-box', { timeout: 5000 })
    await expect(bar).toHaveCount(0)
    await page.keyboard.type('第一步')
    await page.keyboard.press('Enter')
    await expect(topic(page, 'a')).toBeVisible()
    // 新节点占位「新节点」必须被整段替换，不能拼接成「新节点第一步」
    await expect(page.locator('.me-tpc', { hasText: '新节点第一步' })).toHaveCount(0)

    // ② a 有了孩子 → 变成结构节点，「完成」按钮禁用
    await topic(page, 'a').click()
    await expect(bar).toBeVisible()
    await expect(bar.getByRole('button', { name: /✓ 完成/ })).toBeDisabled()

    // ③ 选中新叶子「第一步」→ 点「✓ 完成」→ 折进已完成组（给撤销反馈，不是误删）
    await page.locator('.me-tpc', { hasText: '第一步' }).click()
    await bar.getByRole('button', { name: /✓ 完成/ }).click()
    await expect(page.locator('.mindmap-coach')).toContainText('已完成「第一步」')
    await expect(page.locator('.mindmap-coach')).toContainText('可撤销')
    await expect(page.locator('.me-tpc', { hasText: '已完成' }).first()).toBeVisible()

    // ④ 选中根节点 → 同级 / 删除禁用，子节点可用（趁 a 还在时测：
    //    删掉唯一的子节点后图会变空、触发空图引导，根节点选中态会被重绘冲掉）
    await topic(page, 'proj').click()
    await expect(bar.getByRole('button', { name: /同级/ })).toBeDisabled()
    await expect(bar.getByRole('button', { name: /删除/ })).toBeDisabled()
    await expect(bar.getByRole('button', { name: /子节点/ })).toBeEnabled()

    // ⑤ 选中 a → 点「删除」→ 整棵子树从画布消失（DB 软删）
    await topic(page, 'a').click()
    await bar.getByRole('button', { name: /删除/ }).click()
    await expect(topic(page, 'a')).toHaveCount(0)
    // 落库走 ME operation → applyTodoPatches 的异步链，等它真正写完
    await page.waitForFunction(async () => {
      const { db } = await import('/src/db/db.ts')
      const t = await db.todos.get('a')
      return t?.deleted_at !== null && t?.deleted_at !== undefined
    })
    const deleted = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const t = (await db.todos.get('a'))!
      return { deleted: t.deleted_at !== null, status: t.status }
    })
    expect(deleted.deleted).toBe(true)
    expect(deleted.status).toBe('open') // 删除不篡改 status
  })

  test('单击即改：第一击选中，再点一下就进编辑；操作栏有改名按钮', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    // 第一击：只选中（出现操作栏），不进编辑
    await topic(page, 'a').click()
    await expect(page.locator('.mindmap-actionbar')).toBeVisible()
    await expect(page.locator('#input-box')).toHaveCount(0)

    // 第二击（点已选中的节点）：进编辑 —— 与列表「单击即改」同口径
    await topic(page, 'a').click()
    await page.waitForSelector('#input-box', { timeout: 5000 })
    await page.keyboard.press('Escape')

    // Escape 后 a 仍是选中态（再点会又进编辑），先点根节点换掉选中
    await topic(page, 'proj').click()
    await expect(page.locator('.mindmap-actionbar')).toBeVisible()

    // 操作栏「✎ 改名」按钮同样进编辑
    await topic(page, 'a').click()
    await page.locator('.mindmap-actionbar').getByRole('button', { name: /改名/ }).click()
    await page.waitForSelector('#input-box', { timeout: 5000 })
    await page.keyboard.press('Escape')
  })

  test('节点里写「@李四 明天」→ 自动识别负责人和截止并渲染 @chip', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    await topic(page, 'a').click()
    await page.locator('.mindmap-actionbar').getByRole('button', { name: /改名/ }).click()
    await page.waitForSelector('#input-box', { timeout: 5000 })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    await page.keyboard.type('定稿需求 @李四 明天')
    await page.keyboard.press('Enter')

    // 落库：负责人 + 截止日期被解析出来，标题只留事
    await page.waitForFunction(async () => {
      const { db } = await import('/src/db/db.ts')
      const t = await db.todos.get('a')
      return t?.assignee === '李四' && !!t?.due_date && t?.title === '定稿需求'
    })
    // 画布上渲染出 @chip
    await expect(page.locator('.mindmap-canvas .tags', { hasText: '@李四' })).toBeVisible()
  })

  test('快速添加的落点跟选中走：选中 → 挂到节点下；未选中 → 图根一级分支', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    const input = page.getByPlaceholder(/回车创建/)

    // 选中 a：占位文案报落点，添加后成为 a 的孩子并上画布选中
    await topic(page, 'a').click()
    await expect(input).toHaveAttribute('placeholder', /添加到「定稿需求」下/)
    await input.fill('写验收用例')
    await input.press('Enter')
    await expect.poll(async () => {
      const rows = await page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts')
        return (await db.todos.toArray()).map((t) => ({ title: t.title, parent: t.parent_id }))
      })
      return rows.some((r) => r.title === '写验收用例' && r.parent === 'a')
    }).toBe(true)
    await expect(page.locator('.me-tpc', { hasText: '写验收用例' })).toBeVisible()

    // 点画布空白取消选中：占位文案切回「图的一级分支」
    const box = (await page.locator('.mindmap-canvas .map-container').boundingBox())!
    await page.mouse.click(box.x + 30, box.y + box.height - 30)
    await expect(input).toHaveAttribute('placeholder', /图的一级分支/)
    await input.fill('整理会议纪要')
    await input.press('Enter')
    await expect.poll(async () => {
      const rows = await page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts')
        return (await db.todos.toArray()).map((t) => ({ title: t.title, parent: t.parent_id }))
      })
      return rows.some((r) => r.title === '整理会议纪要' && r.parent === 'proj')
    }).toBe(true)
  })

  test('大纲视图：点选一行后快速添加，挂到该行下面', async ({ page }) => {
    await seed(page)
    await page.locator('aside').getByRole('button', { name: '任务' }).click()
    await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })

    // 切到大纲，点选「定稿需求」一行
    await page.getByRole('button', { name: '大纲', exact: true }).click()
    await page.locator('[data-todo="a"]').click()
    // 选中行必须高亮：子行按自己的 id 比较，不能沿用父行的选中态
    await expect(page.locator('[data-todo="a"]')).toHaveClass(/bg-accent/)
    await expect(page.locator('[data-todo="proj"]')).not.toHaveClass(/bg-accent/)

    const input = page.getByPlaceholder(/回车创建/)
    await expect(input).toHaveAttribute('placeholder', /添加到「定稿需求」下/)
    await input.fill('大纲添加的子任务')
    await input.press('Enter')
    await expect.poll(async () => {
      const rows = await page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts')
        return (await db.todos.toArray()).map((t) => ({ title: t.title, parent: t.parent_id }))
      })
      return rows.some((r) => r.title === '大纲添加的子任务' && r.parent === 'a')
    }).toBe(true)
  })

  test('画布快捷键不劫持工具栏按钮：焦点在按钮上按 Enter 不新增节点', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    // 先选中叶子 a，让画布有编辑目标
    await topic(page, 'a').click()
    // 任务页挂载会自动建 Inbox 根 —— 以按键前的条数为基准
    const countBefore = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      return (await db.todos.count())
    })
    // 焦点移到工具栏按钮（不在画布内），回车只该激活按钮
    await page.getByRole('button', { name: '切换项目图' }).focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')

    await expect.poll(async () => {
      const count = await page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts')
        return db.todos.count()
      })
      return count
    }).toBe(countBefore)
  })

  test('脑图全屏：⛶ 进入沉浸模式，Esc 退出', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    await page.getByRole('button', { name: /全屏/ }).click()
    const fs = page.locator('[data-testid="todos-fullscreen"]')
    await expect(fs).toBeVisible()
    await expect(fs).toHaveClass(/fixed/)
    await expect(fs).toHaveClass(/inset-0/)

    await page.keyboard.press('Escape')
    await expect(fs).toHaveCount(0)
  })

  test('任务来源在脑图可发现：节点来源标 + 操作栏跳转笔记', async ({ page }) => {
    await seed(page)
    // a 是从「周会纪要」笔记创建的任务
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const ts = new Date().toISOString()
      await db.notes.put({ id: 'n1', title: '周会纪要', body_md: '# 本周\n- 定了三件事', todo_ids: [], pinned: false, created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 })
      await db.todos.update('a', { origin_note_id: 'n1' })
    })
    await openMindmap(page)

    // 节点上直接挂来源标（与 @负责人 / 截止同一排灰字）
    await expect(page.locator('.mindmap-canvas .tags', { hasText: '✎ 周会纪要' })).toBeVisible()

    // 选中节点 → 操作栏出现「来源」按钮 → 点击跳到笔记详情
    await topic(page, 'a').click()
    const bar = page.locator('.mindmap-actionbar')
    await bar.getByRole('button', { name: /周会纪要/ }).click()
    await expect(page.locator('input[placeholder="无标题"]')).toHaveValue('周会纪要')
  })

  test('390px 窄屏：操作栏不溢出视口，按钮仍可点', async ({ page }) => {
    await seed(page)
    await openMindmap(page)
    // 进页面后再切窄屏：移动端侧栏会隐藏，走导航反而绕
    await page.setViewportSize({ width: 390, height: 844 })

    await topic(page, 'a').click()
    const bar = page.locator('.mindmap-actionbar')
    await expect(bar).toBeVisible()

    // 之前宽度 594px、左边界 -102px：两端被切出屏，「＋子节点」「删除」点不到
    const box = (await bar.boundingBox())!
    expect(box.width).toBeLessThanOrEqual(390)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)

    await expect(bar.getByRole('button', { name: /删除/ })).toBeInViewport()
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
