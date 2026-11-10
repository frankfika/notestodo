import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test.describe('mindmap undo stack', () => {
  test('Space 完成态可撤销', async ({ page }) => {
    await page.goto(BASE)
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { now } = await import('/src/lib/id.ts')
      const {
        pushTodoStatusUndo,
        undoMindmap,
        clearMindmapUndoStack,
      } = await import('/src/lib/mindmap/undoStack.ts')
      clearMindmapUndoStack()
      await db.todos.clear()
      const ts = now()
      const leaf = {
        id: 'leaf',
        kind: 'task' as const,
        parent_id: null,
        scope: null,
        title: 'leaf',
        status: 'open' as const,
        source: 'manual' as const,
        sort_order: 0,
        map_id: 'leaf',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      }
      await db.todos.put(leaf)
      pushTodoStatusUndo('leaf', 'open')
      await db.todos.update('leaf', { status: 'done', updated_at: ts, sync_version: 1 })
      const afterDone = (await db.todos.get('leaf'))!.status
      const ok = await undoMindmap()
      const afterUndo = (await db.todos.get('leaf'))!.status
      return { afterDone, ok, afterUndo }
    })
    expect(r.afterDone).toBe('done')
    expect(r.ok).toBe(true)
    expect(r.afterUndo).toBe('open')
  })

  test('Today 入槽 / 移出可撤销', async ({ page }) => {
    await page.goto(BASE)
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { now } = await import('/src/lib/id.ts')
      const { setToday, addSlot, getToday, removeSlot } = await import('/src/lib/mindmap/todaySlots.ts')
      const {
        pushTodayStateUndo,
        undoMindmap,
        clearMindmapUndoStack,
      } = await import('/src/lib/mindmap/undoStack.ts')
      clearMindmapUndoStack()
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
      await setToday({ capacity: 5, slots: [] })
      const before = await getToday()
      await addSlot('w1', 'w1')
      pushTodayStateUndo(before, '加入 Today')
      const withSlot = await getToday()
      const u1 = await undoMindmap()
      const afterUndoAdd = await getToday()

      await addSlot('w1', 'w1')
      const beforeRemove = await getToday()
      await removeSlot('w1')
      pushTodayStateUndo(beforeRemove, '移出 Today')
      const u2 = await undoMindmap()
      const afterUndoRemove = await getToday()

      return {
        withSlot: withSlot.slots.length,
        u1,
        afterUndoAdd: afterUndoAdd.slots.length,
        u2,
        afterUndoRemove: afterUndoRemove.slots.some((s) => s.leafId === 'w1'),
      }
    })
    expect(r.withSlot).toBe(1)
    expect(r.u1).toBe(true)
    expect(r.afterUndoAdd).toBe(0)
    expect(r.u2).toBe(true)
    expect(r.afterUndoRemove).toBe(true)
  })

  test('applyTodoPatches 标题写回可撤销', async ({ page }) => {
    await page.goto(BASE)
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { applyTodoPatches } = await import('/src/lib/mindmap/convert.ts')
      const { undoMindmap, clearMindmapUndoStack } = await import('/src/lib/mindmap/undoStack.ts')
      clearMindmapUndoStack()
      await db.todos.clear()
      const ts = new Date().toISOString()
      const root = {
        id: 'root',
        kind: 'task' as const,
        parent_id: null,
        scope: null,
        title: '原标题',
        status: 'open' as const,
        source: 'manual' as const,
        sort_order: 0,
        map_id: 'root',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      }
      await db.todos.put(root)
      await applyTodoPatches([
        { op: 'update', id: 'root', patch: { title: '新标题', updated_at: ts, sync_version: 1 } },
      ])
      const renamed = (await db.todos.get('root'))!.title
      const ok = await undoMindmap()
      const restored = (await db.todos.get('root'))!.title
      return { renamed, ok, restored }
    })
    expect(r.renamed).toBe('新标题')
    expect(r.ok).toBe(true)
    expect(r.restored).toBe('原标题')
  })
})
