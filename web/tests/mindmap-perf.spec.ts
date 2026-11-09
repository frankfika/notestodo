import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

/** F-02 烟测：200 节点 convert 应在合理时间内完成 */
test('todosToMindData 200 节点性能烟测', async ({ page }) => {
  await page.goto(BASE)
  const ms = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { todosToMindData } = await import('/src/lib/mindmap/convert.ts')
    await db.todos.clear()
    const ts = new Date().toISOString()
    const root = {
      id: 'root',
      kind: 'task' as const,
      parent_id: null,
      scope: null,
      title: '大项目',
      status: 'open' as const,
      source: 'manual' as const,
      sort_order: 0,
      map_id: 'root',
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
    }
    const rows = [root]
    for (let i = 0; i < 199; i++) {
      const id = `n${i}`
      rows.push({
        id,
        kind: 'task' as const,
        parent_id: i === 0 ? 'root' : `n${i - 1}`,
        scope: null,
        title: `步骤 ${i + 1}`,
        status: 'open' as const,
        source: 'manual' as const,
        sort_order: i,
        map_id: 'root',
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      })
    }
    await db.todos.bulkPut(rows)
    const t0 = performance.now()
    const data = todosToMindData(await db.todos.toArray(), 'root')
    const t1 = performance.now()
    return { elapsed: t1 - t0, topic: data.nodeData.topic }
  })
  expect(ms.elapsed).toBeLessThan(800)
  expect(ms.topic).toBe('大项目')
})
