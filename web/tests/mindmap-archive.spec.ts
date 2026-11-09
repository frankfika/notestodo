import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test.describe('map archive', () => {
  test('归档后不出现在活跃列表，可还原', async ({ page }) => {
    await page.goto(BASE)
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { archiveMapRoot, listMapRoots, listArchivedMapRoots, unarchiveMapRoot } = await import(
        '/src/lib/mindmap/mapRoots.ts'
      )
      await db.kv.put({ key: 'onboarding_done_v1', value: true })
      await db.todos.clear()
      const ts = new Date().toISOString()
      const root = (id: string, title: string) => ({
        id,
        kind: 'task' as const,
        parent_id: null,
        scope: null,
        title,
        status: 'open' as const,
        source: 'manual' as const,
        sort_order: 0,
        map_id: id,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      })
      await db.todos.bulkPut([root('m1', '项目甲'), root('inbox', 'Inbox')])
      const arch = await archiveMapRoot('m1')
      const active = (await listMapRoots()).map((t) => t.id)
      const archived = (await listArchivedMapRoots()).map((t) => t.id)
      const inboxArch = await archiveMapRoot('inbox')
      await unarchiveMapRoot('m1')
      const active2 = (await listMapRoots()).map((t) => t.id)
      return { arch, active, archived, inboxArch, active2 }
    })
    expect(r.arch).toEqual({ ok: true })
    expect(r.active).toEqual(['inbox'])
    expect(r.archived).toEqual(['m1'])
    expect(r.inboxArch).toEqual({ ok: false, reason: 'inbox' })
    expect(r.active2).toContain('m1')
  })

  test('API PATCH /maps 归档', async ({ page }) => {
    await page.goto(BASE)
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { setFeature } = await import('/src/lib/features.ts')
      await setFeature('mindmap_tasks', true)
      await db.todos.clear()
      const ts = new Date().toISOString()
      await db.todos.put({
        id: 'p1',
        kind: 'task',
        parent_id: null,
        scope: null,
        title: '图乙',
        status: 'open',
        source: 'manual',
        sort_order: 0,
        map_id: 'p1',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      })
      const { routeApiRequest } = await import('/src/api/localApi.ts')
      const patch = await routeApiRequest({
        req_id: 1,
        method: 'PATCH',
        path: '/maps/p1',
        query: '',
        body: JSON.stringify({ archived: true }),
      })
      const list = await routeApiRequest({
        req_id: 2,
        method: 'GET',
        path: '/maps',
        query: '',
        body: '',
      })
      return { patch, list }
    })
    expect(r.patch.status).toBe(200)
    expect((r.patch.body as { map_archived_at: string | null }).map_archived_at).toBeTruthy()
    expect((r.list.body as { id: string }[]).map((x) => x.id)).toEqual([])
  })
})
