import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('todayEligible / isLeafTodo 与快捷键语义一致', async ({ page }) => {
  await page.goto(BASE)
  const r = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { indexByParent, isLeafTodo, todayEligible } = await import('/src/lib/mindmap/leaf.ts')
    await db.todos.clear()
    const ts = new Date().toISOString()
    const base = {
      kind: 'task' as const,
      scope: null,
      status: 'open' as const,
      source: 'manual' as const,
      sort_order: 0,
      map_id: 'm',
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
    }
    await db.todos.bulkPut([
      { ...base, id: 'm', parent_id: null, title: 'm' },
      { ...base, id: 'p', parent_id: 'm', title: '父' },
      { ...base, id: 'leaf', parent_id: 'p', title: '叶' },
    ])
    const all = await db.todos.toArray()
    const by = indexByParent(all)
    const parent = all.find((t) => t.id === 'p')!
    const leaf = all.find((t) => t.id === 'leaf')!
    return {
      parentLeaf: isLeafTodo(parent, by),
      leafLeaf: isLeafTodo(leaf, by),
      parentToday: todayEligible(parent, by),
      leafToday: todayEligible(leaf, by),
    }
  })
  expect(r.parentLeaf).toBe(false)
  expect(r.leafLeaf).toBe(true)
  expect(r.parentToday).toBe(false)
  expect(r.leafToday).toBe(true)
})
