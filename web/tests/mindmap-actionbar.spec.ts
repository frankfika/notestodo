/**
 * 节点操作栏 + 空图引导 + 添加入口（端到端）
 *
 * 痛点回顾：鼠标用户面对画布无从下手、不知道「怎么加任务」。
 * 现在的口径：加节点 = 写任务（创建即命名），常驻入口有三处 ——
 *   ① 左下角「＋ 添加任务」停靠钮（挂到当前选中项下）；
 *   ② hover 节点浮出的「＋」（加子任务）；
 *   ③ 选中节点后的底部操作栏。
 * 本文件覆盖操作栏全按钮、Esc 丢弃空任务、单击即改、
 * 行内 @人/日期 解析、落点提示、截止日期、窄屏、空图引导、折叠角标。
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
  await page.locator('.mindmap-canvas [data-mm-node]').first().waitFor({ state: 'visible', timeout: 15000 })
}

function topic(page: Page, id: string) {
  return page.locator(`.mindmap-canvas [data-mm-node="${id}"]`)
}

test.describe('节点操作栏 + 空图引导', () => {
  test('选中节点出现操作栏：加子任务 / 完成 / 删除全程不用键盘', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    const bar = page.locator('.mindmap-actionbar')

    // 选中叶子 a → 操作栏出现，且按钮齐全
    await topic(page, 'a').click()
    await expect(bar).toBeVisible()
    await expect(bar.getByRole('button', { name: /子任务/ })).toBeEnabled()
    await expect(bar.getByRole('button', { name: /同级/ })).toBeEnabled()
    await expect(bar.getByRole('button', { name: /完成/ })).toBeEnabled()
    await expect(bar.getByRole('button', { name: /上移/ })).toBeVisible()
    await expect(bar.getByRole('button', { name: /下移/ })).toBeVisible()
    await expect(bar.getByRole('button', { name: /删除/ })).toBeEnabled()
    await expect(page.getByRole('button', { name: '适应' })).toBeVisible()

    // ① 点「子任务」→ 进入新任务命名态（操作栏让位）
    await bar.getByRole('button', { name: /子任务/ }).click()
    await page.waitForSelector('[data-testid="mm-editor"]', { timeout: 5000 })
    await expect(bar).toHaveCount(0)
    await page.keyboard.type('第一步')
    await page.keyboard.press('Enter')
    await expect(topic(page, 'a')).toBeVisible()
    // 新任务标题被整段替换（不存在「新节点第一步」这类拼接残留）
    await expect(page.locator('[data-mm-node]', { hasText: '新节点第一步' })).toHaveCount(0)

    // ② a 有了孩子 → 变成结构节点，「完成」按钮禁用
    await topic(page, 'a').click()
    await expect(bar).toBeVisible()
    await expect(bar.getByRole('button', { name: /✓ 完成/ })).toBeDisabled()

    // ③ 选中新叶子「第一步」→ 点「✓ 完成」→ 节点压灰留在画布（给撤销反馈，不是误删）
    await page.locator('[data-mm-node]', { hasText: '第一步' }).click()
    await bar.getByRole('button', { name: /✓ 完成/ }).click()
    await expect(page.locator('.mindmap-coach')).toContainText('已完成「第一步」')
    await expect(page.locator('.mindmap-coach')).toContainText('可撤销')
    const doneNode = page.locator('[data-mm-node]', { hasText: '第一步' })
    await expect(doneNode).toBeVisible()
    await expect(doneNode).toHaveClass(/is-done/)

    // ④ 选中根节点 → 同级 / 删除禁用，子任务可用
    await topic(page, 'proj').click()
    await expect(bar.getByRole('button', { name: /同级/ })).toBeDisabled()
    await expect(bar.getByRole('button', { name: /删除/ })).toBeDisabled()
    await expect(bar.getByRole('button', { name: /子任务/ })).toBeEnabled()

    // ⑤ 选中 a → 点「删除」→ 整棵子树从画布消失（DB 软删，不篡改 status）
    await topic(page, 'a').click()
    await bar.getByRole('button', { name: /删除/ }).click()
    await expect(topic(page, 'a')).toHaveCount(0)
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
    expect(deleted.status).toBe('open')
  })

  test('新建任务后按 Esc 取消：不留下空壳任务', async ({ page }) => {
    await seed(page)
    await openMindmap(page)
    const liveCount = async (): Promise<number> => page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      return db.todos.filter((t) => !t.deleted_at).count()
    })
    const countBefore = await liveCount()

    await topic(page, 'a').click()
    await page.locator('.mindmap-actionbar').getByRole('button', { name: /子任务/ }).click()
    // 创建即进入命名；Esc 丢弃整个占位任务
    await expect(page.locator('[data-testid="mm-editor"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="mm-editor"]')).toHaveCount(0)
    await expect.poll(liveCount).toBe(countBefore)
  })

  test('单击即改：第一击选中，再点一下就进编辑；操作栏有改名按钮', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    // 第一击：只选中（出现操作栏），不进编辑
    await topic(page, 'a').click()
    await expect(page.locator('.mindmap-actionbar')).toBeVisible()
    await expect(page.locator('[data-testid="mm-editor"]')).toHaveCount(0)

    // 第二击（点已选中的节点）：进编辑
    await topic(page, 'a').click()
    await page.waitForSelector('[data-testid="mm-editor"]', { timeout: 5000 })
    await page.keyboard.press('Escape')

    // Escape 后 a 仍是选中态，先点根节点换掉选中
    await topic(page, 'proj').click()
    await expect(page.locator('.mindmap-actionbar')).toBeVisible()

    // 操作栏「改名」按钮同样进编辑
    await topic(page, 'a').click()
    await page.locator('.mindmap-actionbar').getByRole('button', { name: /改名/ }).click()
    await page.waitForSelector('[data-testid="mm-editor"]', { timeout: 5000 })
    await page.keyboard.press('Escape')
  })

  test('任务里写「@李四 明天」→ 自动识别负责人和截止并渲染 chip', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    await topic(page, 'a').click()
    await page.locator('.mindmap-actionbar').getByRole('button', { name: /改名/ }).click()
    await page.waitForSelector('[data-testid="mm-editor"]', { timeout: 5000 })
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    await page.keyboard.type('定稿需求 @李四 明天')
    await page.keyboard.press('Enter')

    // 落库：负责人 + 截止日期被解析出来，标题只留事
    await page.waitForFunction(async () => {
      const { db } = await import('/src/db/db.ts')
      const t = await db.todos.get('a')
      return t?.assignee === '李四' && !!t?.due_date && t?.title === '定稿需求'
    })
    // 画布上渲染出 chip
    await expect(page.locator('.mindmap-canvas .mm-chip', { hasText: '@李四' })).toBeVisible()
  })

  test('快速添加的落点跟选中走：选中 → 挂到节点下；未选中 → 图根一级分支', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    const input = page.getByPlaceholder(/回车创建/)

    // 选中 a：占位文案报落点，添加后成为 a 的孩子
    await topic(page, 'a').click()
    await expect(input).toHaveAttribute('placeholder', /加到「定稿需求」下/)
    await input.fill('写验收用例')
    await input.press('Enter')
    await expect.poll(async () => {
      const rows = await page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts')
        return (await db.todos.toArray()).map((t) => ({ title: t.title, parent: t.parent_id }))
      })
      return rows.some((r) => r.title === '写验收用例' && r.parent === 'a')
    }).toBe(true)
    await expect(page.locator('[data-mm-node]', { hasText: '写验收用例' })).toBeVisible()

    // 点画布空白（右下角，避开左下角停靠栏）取消选中：占位文案切回「第一层」
    const box = (await page.locator('.mindmap-canvas').boundingBox())!
    await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30)
    await expect(input).toHaveAttribute('placeholder', /的第一层/)
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

  test('左下角「＋ 添加任务」：加节点即写任务，挂到当前选中项下', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    // 选中 a，再点停靠栏「＋ 添加任务」
    await topic(page, 'a').click()
    await page.getByRole('button', { name: '＋ 添加任务' }).click()
    // 直接进入命名态
    await expect(page.locator('[data-testid="mm-editor"]')).toBeVisible()
    await page.keyboard.type('停靠栏加的任务')
    await page.keyboard.press('Enter')
    await expect.poll(async () => {
      const rows = await page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts')
        return (await db.todos.toArray()).map((t) => ({ title: t.title, parent: t.parent_id }))
      })
      return rows.some((r) => r.title === '停靠栏加的任务' && r.parent === 'a')
    }).toBe(true)
  })

  test('大纲视图：点选一行后快速添加，挂到该行下面', async ({ page }) => {
    await seed(page)
    await page.locator('aside').getByRole('button', { name: '任务' }).click()
    await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })

    // 切到大纲，点选「定稿需求」一行
    await page.getByRole('button', { name: '大纲', exact: true }).click()
    await page.locator('[data-todo="a"]').click()
    await expect(page.locator('[data-todo="a"]')).toHaveClass(/bg-accent/)
    await expect(page.locator('[data-todo="proj"]')).not.toHaveClass(/bg-accent/)

    const input = page.getByPlaceholder(/回车创建/)
    await expect(input).toHaveAttribute('placeholder', /加到「定稿需求」下/)
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

  test('画布快捷键不劫持工具栏按钮：焦点在按钮上按 Enter 不新增任务', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    await topic(page, 'a').click()
    const countBefore = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      return (await db.todos.count())
    })
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

  test('脑图沉浸：进入沉浸模式，Esc 退出', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    await page.getByRole('button', { name: /沉浸/ }).click()
    const fs = page.locator('[data-testid="todos-fullscreen"]')
    await expect(fs).toBeVisible()
    await expect(fs).toHaveClass(/fixed/)
    await expect(fs).toHaveClass(/inset-0/)

    await page.keyboard.press('Escape')
    await expect(fs).toHaveCount(0)
  })

  test('任务来源在脑图可发现：节点来源 chip + 操作栏跳转笔记', async ({ page }) => {
    await seed(page)
    // a 是从「周会纪要」笔记创建的任务
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const ts = new Date().toISOString()
      await db.notes.put({ id: 'n1', title: '周会纪要', body_md: '# 本周\n- 定了三件事', todo_ids: [], pinned: false, created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 })
      await db.todos.update('a', { origin_note_id: 'n1' })
    })
    await openMindmap(page)

    // 节点上直接挂来源 chip
    await expect(page.locator('.mindmap-canvas .mm-chip', { hasText: '✎ 周会纪要' })).toBeVisible()

    // 选中节点 → 操作栏出现「来源」按钮 → 点击跳到笔记详情
    await topic(page, 'a').click({ position: { x: 12, y: 10 } })
    const bar = page.locator('.mindmap-actionbar')
    await bar.getByRole('button', { name: /周会纪要/ }).click()
    await expect(page.locator('input[placeholder="无标题"]')).toHaveValue('周会纪要')
  })

  test('脑图操作栏可直接设置 / 清空截止日期', async ({ page }) => {
    await seed(page)
    await openMindmap(page)

    await topic(page, 'a').click()
    const bar = page.locator('.mindmap-actionbar')
    const dateInput = bar.locator('input[type="date"]')
    // 用「今天之后」的动态日期：dueTag 对过期日期渲染「逾期 …」，
    // 硬编码日期会让这条用例在某天之后必挂（CI 曾于 2026-11-25 起因此失败）。
    const d = new Date(Date.now() + 3 * 86_400_000)
    const pad = (n: number): string => String(n).padStart(2, '0')
    const due = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const mmdd = due.slice(5).replace('-', '/')
    await dateInput.fill(due)

    await expect.poll(async () => {
      const t = await page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts')
        return db.todos.get('a')
      })
      return t?.due_date ?? null
    }).toBe(due)
    await expect(page.locator('.mindmap-canvas .mm-chip', { hasText: `截止 ${mmdd}` })).toBeVisible()

    await bar.getByRole('button', { name: '清空截止日期' }).click()
    await expect.poll(async () => {
      const t = await page.evaluate(async () => {
        const { db } = await import('/src/db/db.ts')
        return db.todos.get('a')
      })
      return t?.due_date ?? null
    }).toBeNull()
  })

  test('390px 窄屏：操作栏不溢出视口，按钮仍可点', async ({ page }) => {
    await seed(page)
    await openMindmap(page)
    await page.setViewportSize({ width: 390, height: 844 })

    await topic(page, 'a').click()
    const bar = page.locator('.mindmap-actionbar')
    await expect(bar).toBeVisible()

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
    // 引导不能压在根节点上
    const hintBox = (await hint.boundingBox())!
    const rootBox = (await page.locator('.mindmap-canvas [data-mm-node]').first().boundingBox())!
    expect(hintBox.y).toBeGreaterThanOrEqual(rootBox.y + rootBox.height)
    await hint.getByRole('button', { name: '＋ 添加第一条任务' }).click()

    // 直接进入命名态，打字即写标题
    await page.waitForSelector('[data-testid="mm-editor"]', { timeout: 5000 })
    await page.keyboard.type('第一件事')
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-mm-node]', { hasText: '第一件事' })).toBeVisible()
    // 有内容后引导消失
    await expect(hint).toHaveCount(0)
  })

  test('折叠的节点显示子节点数；hover 浮出「＋」一键加子任务', async ({ page }) => {
    await seed(page)
    // 给 a 挂两个子节点
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
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
        parent_id: 'a',
      }
      await db.todos.bulkPut([
        { ...base, id: 'a1', title: '子一', sort_order: 1 } as never,
        { ...base, id: 'a2', title: '子二', sort_order: 2 } as never,
      ])
    })
    await openMindmap(page)

    const node = topic(page, 'a')
    // 点折叠钮 → 角标显示子节点数
    await node.locator('.mm-fold').click()
    await expect(node.locator('.mm-count')).toHaveText('2')
    await expect(node.locator('.mm-count')).toBeVisible()
    await expect(topic(page, 'a1')).toHaveCount(0)

    // hover 浮出「＋」→ 点一下直接建子任务并进命名
    await node.hover()
    const plus = node.locator('.mm-node-add')
    await expect(plus).toBeVisible()
    await plus.click()
    await expect(page.locator('[data-testid="mm-editor"]')).toBeVisible()
  })
})
