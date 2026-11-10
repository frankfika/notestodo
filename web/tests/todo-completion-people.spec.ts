/**
 * F-10 · 完成记录 + 关联人（多层级 / 内部不对外）
 *
 * 覆盖：
 *  ① 完成日期：状态翻成 done 时自动记一笔，翻回 open 清空
 *     —— 列表、看板、Today、笔记、脑图、本地 API 都要记（口径收口在一处）
 *  ② 关联人：本地人员目录（部门 / 小组 / 个人 多层级），可自建
 *  ③ 内部人员默认不对外：「含内部」才看得到
 *  ④ 串联：完成项上能同时看到「谁 · 什么时候 · 完成了什么」
 *  ⑤ 归档：被否掉的事（投资A 黄了）→ 关掉，但留下带时间的记录
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
      { ...base, id: 'proj', parent_id: null, title: '项目甲', sort_order: -2 },
      { ...base, id: 'a', parent_id: 'proj', title: '定稿需求', sort_order: 1 },
    ])
  })
}

async function todoOf(page: Page, id: string): Promise<{
  status: string
  assignee?: string
  completed_at?: string | null
  archived_at?: string | null
} | null> {
  return page.evaluate(async (tid) => {
    const { db } = await import('/src/db/db.ts')
    const t = await db.todos.get(tid)
    return t
      ? { status: t.status, assignee: t.assignee, completed_at: t.completed_at, archived_at: t.archived_at }
      : null
  }, id)
}

/** 打开「按时间」列表 Tab */
async function openList(page: Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: '任务' }).click()
  await page.getByRole('button', { name: '按时间' }).click()
  await page.locator('[data-todo="a"]').waitFor({ state: 'visible', timeout: 15000 })
}

test.describe('完成记录 + 关联人', () => {
  test('① 完成日期：勾选完成自动记一笔，取消完成清空', async ({ page }) => {
    await seed(page)
    await openList(page)

    // 受控 checkbox：点一下，状态由 DB 回流，别用 check()（它要求点击后立刻变）
    await page.locator('[data-todo="a"] input[type="checkbox"]').click()
    await expect.poll(async () => (await todoOf(page, 'a'))?.completed_at).toBeTruthy()
    const done = await todoOf(page, 'a')
    expect(done?.status).toBe('done')
    // 记的是今天
    expect(done?.completed_at?.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10))
    // 切到「已完成」视图 —— 完成记录默认被「进行中」过滤掉了
    await page.getByRole('button', { name: '已完成' }).click()
    // 行上能看到完成日期
    await expect(page.locator('[data-todo="a"]').getByTitle('完成日期')).toBeVisible()

    await page.locator('[data-todo="a"] input[type="checkbox"]').click()
    await expect.poll(async () => (await todoOf(page, 'a'))?.completed_at).toBeFalsy()
    expect((await todoOf(page, 'a'))?.status).toBe('open')
  })

  test('①b 脑图里 Space 完成也记完成日期（口径一致）', async ({ page }) => {
    await seed(page)
    await page.locator('aside').getByRole('button', { name: '任务' }).click()
    await page.locator('.mindmap-canvas .me-tpc').first().waitFor({ state: 'visible', timeout: 15000 })
    await page.locator('.mindmap-canvas .me-tpc[data-nodeid="mea"]').click()
    await page.waitForTimeout(200)
    await page.keyboard.press('Space')
    await expect.poll(async () => (await todoOf(page, 'a'))?.status).toBe('done')
    expect((await todoOf(page, 'a'))?.completed_at).toBeTruthy()
  })

  test('② 关联人：从目录里选一个，行上出现 @人', async ({ page }) => {
    await seed(page)
    await openList(page)

    await page.locator('[data-todo="a"]').getByTitle('更多操作').click()
    await page.getByTitle('关联人').click()
    // 目录里能选到人（李娜 · 产品组）
    await page.locator('button[data-person-name="李娜"]').click()

    await expect.poll(async () => (await todoOf(page, 'a'))?.assignee).toBe('李娜')
    await expect(page.locator('[data-todo="a"]').getByText('@李娜').first()).toBeVisible()
  })

  test('③ 内部人员默认不对外，勾上「含内部」才出现', async ({ page }) => {
    await seed(page)
    await openList(page)

    await page.locator('[data-todo="a"]').getByTitle('更多操作').click()
    await page.getByTitle('关联人').click()

    // 张伟是「管理人 + 内部」→ 默认不列出来
    await expect(page.locator('button[data-person-name="张伟"]')).toHaveCount(0)
    // 但层级分组在
    await expect(page.getByText('部门', { exact: true })).toBeVisible()
    await expect(page.getByText('小组', { exact: true })).toBeVisible()
    await expect(page.getByText('个人', { exact: true })).toBeVisible()

    // 勾「含内部」→ 内部的管理人出现
    await page.getByLabel('含内部人员（不对外）').check()
    await expect(page.locator('button[data-person-name="张伟"]')).toBeVisible()
    await expect(page.locator('button[data-person-name="张伟"]')).toContainText('内部')
  })

  test('④ 可以自己新建人员（多个层级）并直接关联', async ({ page }) => {
    await seed(page)
    await openList(page)

    await page.locator('[data-todo="a"]').getByTitle('更多操作').click()
    await page.getByTitle('关联人').click()
    await page.getByRole('button', { name: '+ 新建人员' }).click()
    await page.getByPlaceholder('名字，如「王工」').fill('王工')
    // 挂到「研发组」下面 —— 多个层级
    await page.locator('select').last().selectOption({ label: '研发组' })
    await page.getByRole('button', { name: '建好并关联' }).click()

    await expect.poll(async () => (await todoOf(page, 'a'))?.assignee).toBe('王工')
    const people = await page.evaluate(async () => {
      const { readPeople } = await import('/src/lib/people.ts')
      return (await readPeople()).find((p) => p.name === '王工') ?? null
    })
    expect(people?.level).toBe('person')
    expect(people?.parent_id).toBe('p-team-dev')
  })

  test('⑥ 归档：被否掉的事关掉，但留下带时间的记录', async ({ page }) => {
    await seed(page)
    await openList(page)

    await page.locator('[data-todo="a"]').getByTitle('更多操作').click()
    await page.getByRole('button', { name: '归档（这件事黄了）' }).click()

    // 归档时间 + 结束时间都记上了
    await expect.poll(async () => (await todoOf(page, 'a'))?.archived_at).toBeTruthy()
    const archived = await todoOf(page, 'a')
    expect(archived?.status).toBe('cancelled')
    expect(archived?.completed_at).toBeTruthy()
    expect(archived?.completed_at?.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10))

    // 进行中里不该再有它了
    await expect(page.locator('[data-todo="a"]')).toHaveCount(0)

    // 「已归档」里能看到记录 + 归档日期
    await page.getByRole('button', { name: '已归档' }).click()
    await expect(page.locator('[data-todo="a"]')).toBeVisible()
    await expect(page.locator('[data-todo="a"]').getByTitle('归档日期')).toBeVisible()
    await expect(page.locator('[data-todo="a"]').getByTitle('完成日期')).toBeVisible()
  })

  test('⑥b 归档可以撤销，取消归档后回到进行中', async ({ page }) => {
    await seed(page)
    await openList(page)

    await page.locator('[data-todo="a"]').getByTitle('更多操作').click()
    await page.getByRole('button', { name: '归档（这件事黄了）' }).click()
    await expect.poll(async () => (await todoOf(page, 'a'))?.status).toBe('cancelled')

    await page.getByRole('button', { name: '已归档' }).click()
    await page.locator('[data-todo="a"]').getByTitle('更多操作').click()
    await page.getByRole('button', { name: '取消归档' }).click()

    await expect.poll(async () => (await todoOf(page, 'a'))?.status).toBe('open')
    expect((await todoOf(page, 'a'))?.archived_at).toBeFalsy()
  })

  test('⑥c 归档掉的事不再出现在脑图上（已经不存在了）', async ({ page }) => {
    await seed(page)
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      await db.todos.update('a', { status: 'cancelled', archived_at: new Date().toISOString() })
    })
    await page.locator('aside').getByRole('button', { name: '任务' }).click()
    await page.locator('.mindmap-canvas .me-tpc').first().waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(600)
    await expect(page.locator('.mindmap-canvas .me-tpc[data-nodeid="mea"]')).toHaveCount(0)
  })

  test('⑦ 完成 / 归档后，Today 槽位自动让出来', async ({ page }) => {
    await seed(page)
    const slotCount = async (): Promise<number> =>
      page.evaluate(async () => {
        const { getToday } = await import('/src/lib/mindmap/todaySlots.ts')
        return (await getToday()).slots.length
      })

    await page.evaluate(async () => {
      const { addSlot } = await import('/src/lib/mindmap/todaySlots.ts')
      await addSlot('a', 'proj')
    })
    expect(await slotCount()).toBe(1)

    // 归档 → 槽位自动清（purgeIneligibleSlots 之前没人调，挂到状态收口上了）
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { archiveTodo } = await import('/src/lib/todoStatus.ts')
      const t = await db.todos.get('a')
      await archiveTodo(t!)
    })
    await expect.poll(slotCount).toBe(0)
  })

  test('⑤ 脑图节点上带出关联人（完成项还带完成日期）', async ({ page }) => {
    await seed(page)
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      await db.todos.update('a', { assignee: '李娜', completed_at: new Date().toISOString(), status: 'done' })
    })
    await page.locator('aside').getByRole('button', { name: '任务' }).click()
    await page.locator('.mindmap-canvas .me-tpc').first().waitFor({ state: 'visible', timeout: 15000 })
    // 「已完成 (1)」折叠组里挂着完成项
    const group = page.locator('.mindmap-canvas .me-tpc', { hasText: '已完成' }).first()
    await expect(group).toBeVisible()
    // 展开用 ME 的折叠三角（双击文字是「改名」，不是展开）
    await page.locator('.mindmap-canvas .me-epd').first().click()
    await page.waitForTimeout(800)
    await expect(page.locator('.mindmap-canvas .me-tpc', { hasText: '定稿需求' }).first()).toBeVisible()
    await expect(page.locator('.mindmap-canvas .me-tpc .tags').first()).toContainText('@李娜')
  })
})
