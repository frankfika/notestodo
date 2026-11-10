import { test, expect } from '@playwright/test'

test.describe('attachToMap / mapRoots', () => {
  test('defaultConfirmTarget 含会议分支；attach 保留 transcript_span', async ({ page }) => {
    await page.goto('/')
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { setFeature } = await import('/src/lib/features.ts')
      await db.kv.put({ key: 'onboarding_done_v1', value: true })
      await setFeature('mindmap_tasks', true)
      await db.todos.clear()
      await db.meetings.clear()
      const ts = new Date().toISOString()
      const mid = 'm1'
      await db.meetings.add({
        id: mid,
        title: '周会',
        status: 'summarized',
        started_at: ts,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      })
      const { defaultConfirmTarget, attachTaskToMap } = await import('/src/lib/mindmap/attachToMap.ts')
      const m = (await db.meetings.get(mid))!
      const target = await defaultConfirmTarget(m)
      const tid = 't1'
      await db.todos.add({
        id: tid,
        kind: 'task',
        parent_id: null,
        scope: null,
        title: '发首页文案',
        status: 'pending_review',
        source: 'meeting',
        meeting_id: mid,
        sort_order: 0,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
        transcript_span: { start_ms: 1000, end_ms: 2000, quote: '发我文案' },
      })
      const t = (await db.todos.get(tid))!
      await attachTaskToMap(t, target)
      const after = await db.todos.get(tid)
      return { target, after }
    })
    expect(r.target.label).toContain('本次会议 · 周会')
    expect(r.after?.status).toBe('open')
    expect(r.after?.map_id).toBe(r.target.mapId)
    expect(r.after?.parent_id).toBe(r.target.parentId)
    expect(r.after?.transcript_span?.quote).toBe('发我文案')
  })
})
