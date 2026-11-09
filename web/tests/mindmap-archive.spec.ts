import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

type ApiReq = { req_id: number; method: string; path: string; query: string; body: string }

function call(page: Page, method: string, path: string, body?: unknown, query = ''): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async ({ method, path, body, query }) => {
    const { routeApiRequest } = await import('/src/api/localApi.ts')
    const req: ApiReq = { req_id: 1, method, path, query, body: body === undefined ? '' : JSON.stringify(body) }
    const r = await routeApiRequest(req)
    return { status: r.status, body: r.body }
  }, { method, path, body, query })
}

test.describe('图归档', () => {
  test.beforeEach(async ({ page }) => {
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
        status: 'done' as const,
        source: 'manual' as const,
        sort_order: 0,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      }
      await db.todos.bulkPut([
        { id: 'inbox', parent_id: null, title: 'Inbox', map_id: 'inbox', ...base, status: 'open' },
        { id: 'proj', parent_id: null, title: '项目甲', map_id: 'proj', ...base },
        { id: 'leaf', parent_id: 'proj', title: '尾步', map_id: 'proj', ...base, status: 'done' },
        { id: 'openMap', parent_id: null, title: '仍有开放', map_id: 'openMap', ...base, status: 'open' },
        { id: 'openLeaf', parent_id: 'openMap', title: '待办', map_id: 'openMap', ...base, status: 'open' },
      ])
    })
  })

  test('API：列表 / 归档 / 恢复；开放叶子拦截', async ({ page }) => {
    let r = await call(page, 'GET', '/maps')
    expect(r.status).toBe(200)
    const active = (r.body as { id: string }[]).map((m) => m.id)
    expect(active).toContain('inbox')
    expect(active).toContain('proj')
    expect(active).toContain('openMap')

    r = await call(page, 'POST', '/maps/inbox/archive')
    expect(r.status).toBe(409)

    r = await call(page, 'POST', '/maps/openMap/archive')
    expect(r.status).toBe(409)
    expect((r.body as { error: string }).error).toBe('open_leaves')

    r = await call(page, 'POST', '/maps/proj/archive')
    expect(r.status).toBe(200)
    expect((r.body as { archived_at: string | null }).archived_at).toBeTruthy()

    r = await call(page, 'GET', '/maps')
    expect((r.body as { id: string }[]).some((m) => m.id === 'proj')).toBe(false)

    r = await call(page, 'GET', '/maps', undefined, 'archived=1')
    expect((r.body as { id: string }[]).map((m) => m.id)).toContain('proj')

    r = await call(page, 'POST', '/maps/proj/restore')
    expect(r.status).toBe(200)
    expect((r.body as { archived_at: string | null }).archived_at).toBeNull()

    r = await call(page, 'GET', '/maps', undefined, 'archived=1')
    expect((r.body as { id: string }[]).some((m) => m.id === 'proj')).toBe(false)
  })

  test('archiveMap：归档后踢出 Today 槽', async ({ page }) => {
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { setToday, getToday } = await import('/src/lib/mindmap/todaySlots.ts')
      const { archiveMap } = await import('/src/lib/mindmap/mapArchive.ts')
      const ts = new Date().toISOString()
      const base = {
        kind: 'task' as const,
        scope: null,
        source: 'manual' as const,
        sort_order: 1,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      }
      await db.todos.bulkPut([
        { id: 'm1', parent_id: null, title: '收尾图', status: 'open', map_id: 'm1', ...base },
        { id: 'c1', parent_id: 'm1', title: '最后一步', status: 'done', map_id: 'm1', ...base },
      ])
      await setToday({
        capacity: 5,
        slots: [{ leafId: 'c1', mapId: 'm1', slottedAt: ts }],
      })
      const beforeSlots = (await getToday()).slots.length
      const arc = await archiveMap('m1')
      const afterSlots = (await getToday()).slots.length
      return { arc, beforeSlots, afterSlots }
    })
    expect(r.arc.ok).toBe(true)
    expect(r.beforeSlots).toBe(1)
    expect(r.afterSlots).toBe(0)
  })
})
