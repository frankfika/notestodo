import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test.describe('todaySlots', () => {
  test('满槽返回 full；swap 成功', async ({ page }) => {
    await page.goto(BASE)
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { setToday, addSlot, swapSlot } = await import('/src/lib/mindmap/todaySlots.ts')
      await db.kv.put({ key: 'onboarding_done_v1', value: true })
      await db.todos.clear()
      const ts = new Date().toISOString()
      const leaf = (id: string) => ({
        id,
        kind: 'task' as const,
        parent_id: null,
        scope: null,
        title: id,
        status: 'open' as const,
        source: 'manual' as const,
        sort_order: 0,
        map_id: id,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      })
      await db.todos.bulkPut([leaf('a'), leaf('b'), leaf('c'), leaf('d')])
      await setToday({ capacity: 3, slots: [] })
      const r1 = await addSlot('a', 'a')
      const r2 = await addSlot('b', 'b')
      const r2b = await addSlot('c', 'c')
      const r3fail = await addSlot('d', 'd')
      const r3 = await swapSlot('d', 'd', 'a')
      return { r1, r2, r2b, r3fail, r3 }
    })
    expect(r.r1.ok).toBe(true)
    expect(r.r2.ok).toBe(true)
    expect(r.r2b.ok).toBe(true)
    expect(r.r3fail.ok).toBe(false)
    expect((r.r3fail as { reason: string }).reason).toBe('full')
    expect(r.r3.ok).toBe(true)
  })

  test('入槽 / 手动移除 / 结构变化踢槽', async ({ page }) => {
    await page.goto(BASE)
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { uid, now } = await import('/src/lib/id.ts')
      const {
        setToday,
        addSlot,
        removeSlot,
        evictIfPresent,
        purgeIneligibleSlots,
        getToday,
      } = await import('/src/lib/mindmap/todaySlots.ts')
      await db.kv.put({ key: 'onboarding_done_v1', value: true })
      await db.todos.clear()
      const ts = now()
      const root = {
        id: 'root',
        kind: 'task' as const,
        parent_id: null,
        scope: null,
        title: 'root',
        status: 'open' as const,
        source: 'manual' as const,
        sort_order: 0,
        map_id: 'root',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      }
      const leaf = {
        id: 'leaf',
        kind: 'task' as const,
        parent_id: 'root',
        scope: null,
        title: 'leaf',
        status: 'open' as const,
        source: 'manual' as const,
        sort_order: 1,
        map_id: 'root',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      }
      await db.todos.bulkPut([root, leaf])
      await setToday({ capacity: 5, slots: [] })
      const add = await addSlot('leaf', 'root')
      const removed = await removeSlot('leaf')
      const add2 = await addSlot('leaf', 'root')
      await db.todos.add({
        id: uid(),
        kind: 'task',
        parent_id: 'leaf',
        scope: null,
        title: 'child',
        status: 'open',
        source: 'manual',
        sort_order: 2,
        map_id: 'root',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      })
      await evictIfPresent('leaf')
      const purged = await purgeIneligibleSlots()
      const final = await getToday()
      return { add, removed, add2, purged, final }
    })
    expect(r.add.ok).toBe(true)
    expect(r.removed.slots).toHaveLength(0)
    expect(r.add2.ok).toBe(true)
    expect(r.final.slots.some((s) => s.leafId === 'leaf')).toBe(false)
  })

  test('Waiting / 完成态不可入槽且 purge 清扫', async ({ page }) => {
    await page.goto(BASE)
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { now } = await import('/src/lib/id.ts')
      const { setToday, addSlot, purgeIneligibleSlots } = await import('/src/lib/mindmap/todaySlots.ts')
      await db.kv.put({ key: 'onboarding_done_v1', value: true })
      await db.todos.clear()
      const ts = now()
      const t = {
        id: 'w1',
        kind: 'task' as const,
        parent_id: null,
        scope: null,
        title: 'w1',
        status: 'open' as const,
        source: 'manual' as const,
        sort_order: 0,
        map_id: 'w1',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      }
      await db.todos.put(t)
      await setToday({
        capacity: 5,
        slots: [{ leafId: 'w1', mapId: 'w1', slottedAt: ts }],
      })
      await db.todos.update('w1', { waiting_reason: '等设计', updated_at: ts })
      const p1 = await purgeIneligibleSlots()
      await db.todos.update('w1', { waiting_reason: undefined, status: 'open', updated_at: ts })
      await setToday({
        capacity: 5,
        slots: [{ leafId: 'w1', mapId: 'w1', slottedAt: ts }],
      })
      await db.todos.update('w1', { status: 'done', updated_at: ts })
      const p2 = await purgeIneligibleSlots()
      const blocked = await addSlot('w1', 'w1')
      return { p1, p2, blocked }
    })
    expect(r.p1.slots).toHaveLength(0)
    expect(r.p2.slots).toHaveLength(0)
    expect(r.blocked.ok).toBe(false)
    expect((r.blocked as { reason: string }).reason).toBe('not_eligible')
  })
})
