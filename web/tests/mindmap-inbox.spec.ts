import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test.describe('inbox capture', () => {
  test('捕获入 Inbox 并列出', async ({ page }) => {
    await page.goto(BASE)
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { captureToInbox, listInboxCaptures } = await import('/src/lib/mindmap/inboxCapture.ts')
      const { ensureInboxMap } = await import('/src/lib/mindmap/mapRoots.ts')
      await db.kv.put({ key: 'onboarding_done_v1', value: true })
      await db.todos.clear()
      const inbox = await ensureInboxMap()
      await captureToInbox('快速想法')
      const items = await listInboxCaptures()
      return { inboxId: inbox.id, items: items.map((t) => ({ title: t.title, parent_id: t.parent_id })) }
    })
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.title).toBe('快速想法')
    expect(r.items[0]!.parent_id).toBe(r.inboxId)
  })

  test('Inbox 根图只建一个（StrictMode 双挂载不会重复建）', async ({ page }) => {
    await page.goto(BASE)
    await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { setFeature } = await import('/src/lib/features.ts')
      await db.kv.put({ key: 'onboarding_done_v1', value: true })
      await db.todos.clear()
      await setFeature('mindmap_tasks', true)
    })
    // 进任务页 → 脑图 Tab → InboxSidebar 挂载
    // （dev 下 React StrictMode 会把 effect 跑两遍 → ensureInboxMap 被并发调两次）
    await page.locator('aside').getByRole('button', { name: '任务' }).click()
    await page.locator('.mindmap-canvas').waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(1500)
    const inboxRoots = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const all = await db.todos.toArray()
      return all.filter((t) => t.parent_id === null && t.title === 'Inbox').map((t) => t.id)
    })
    expect(inboxRoots).toHaveLength(1)
  })

  test('Waiting 节点标题带标记', async ({ page }) => {
    await page.goto(BASE)
    const topic = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { todosToMindData } = await import('/src/lib/mindmap/convert.ts')
      await db.todos.clear()
      const ts = new Date().toISOString()
      const root = {
        id: 'r1',
        kind: 'task' as const,
        parent_id: null,
        scope: null,
        title: '根',
        status: 'open' as const,
        source: 'manual' as const,
        sort_order: 0,
        map_id: 'r1',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      }
      const leaf = {
        ...root,
        id: 'l1',
        parent_id: 'r1',
        title: '等反馈',
        waiting_reason: '设计',
      }
      await db.todos.bulkPut([root, leaf])
      const data = todosToMindData(await db.todos.toArray(), 'r1')
      const child = data.nodeData.children?.[0]
      return child?.topic
    })
    expect(topic).toContain('Waiting')
  })

  test('API POST/GET /inbox/captures', async ({ page }) => {
    await page.goto(BASE)
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { setFeature } = await import('/src/lib/features.ts')
      await setFeature('mindmap_tasks', true)
      await db.todos.clear()
      const { routeApiRequest } = await import('/src/api/localApi.ts')
      const post = await routeApiRequest({
        req_id: 1,
        method: 'POST',
        path: '/inbox/captures',
        query: '',
        body: JSON.stringify({ title: 'API 捕获' }),
      })
      const list = await routeApiRequest({
        req_id: 2,
        method: 'GET',
        path: '/inbox/captures',
        query: '',
        body: '',
      })
      return { post, list }
    })
    expect(r.post.status).toBe(201)
    expect((r.list.body as { title: string }[])[0]!.title).toBe('API 捕获')
  })
})
