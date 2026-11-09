import { test, expect } from '@playwright/test'
import { listInboxCaptureLeaves } from '../src/lib/mindmap/inbox'
import type { Todo } from '../src/types'

function t(id: string, parent: string | null, extra: Partial<Todo> = {}): Todo {
  return {
    id,
    kind: 'task',
    scope: null,
    parent_id: parent,
    title: id,
    status: 'open',
    source: 'manual',
    sort_order: 0,
    map_id: parent ?? id,
    created_at: '',
    updated_at: '',
    deleted_at: null,
    sync_version: 0,
    ...extra,
  }
}

test.describe('inbox capture', () => {
  test('ensureInboxMap 幂等；捕获叶子仅在 Inbox 下列出', async ({ page }) => {
    await page.goto(process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/')
    const r = await page.evaluate(async () => {
      const { db } = await import('/src/db/db.ts')
      const { ensureInboxMap } = await import('/src/lib/mindmap/mapRoots.ts')
      const { listInboxCaptureLeaves } = await import('/src/lib/mindmap/inbox.ts')
      await db.todos.clear()
      const a = await ensureInboxMap()
      const b = await ensureInboxMap()
      const inboxId = a.id
      const ts = new Date().toISOString()
      const mk = (id: string, parent: string, title: string, sort: number) => ({
        id,
        kind: 'task' as const,
        parent_id: parent,
        scope: null,
        title,
        status: 'open' as const,
        source: 'manual' as const,
        sort_order: sort,
        map_id: inboxId,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
        sync_version: 0,
      })
      await db.todos.bulkPut([
        mk('leaf1', inboxId, '买牛奶', 10),
        mk('leaf2', inboxId, '回信', 20),
        mk('branch', inboxId, '分支', 5),
        mk('sub', 'branch', '子', 1),
      ])
      const all = await db.todos.toArray()
      const leaves = listInboxCaptureLeaves(all, inboxId)
      return { same: a.id === b.id, title: a.title, leafIds: leaves.map((x) => x.id).sort() }
    })
    expect(r.same).toBe(true)
    expect(r.title).toBe('Inbox')
    expect(r.leafIds).toEqual(['leaf1', 'leaf2'])
  })

  test('listInboxCaptureLeaves 纯逻辑', () => {
    const inboxId = 'inbox'
    const all = [
      t('inbox', null, { title: 'Inbox', map_id: inboxId }),
      t('leaf1', inboxId, { map_id: inboxId, title: '买牛奶', sort_order: 10 }),
      t('leaf2', inboxId, { map_id: inboxId, title: '回信', sort_order: 20 }),
      t('branch', inboxId, { map_id: inboxId, sort_order: 5 }),
      t('sub', 'branch', { map_id: inboxId, sort_order: 1 }),
    ]
    const leaves = listInboxCaptureLeaves(all, inboxId)
    expect(leaves.map((x) => x.id).sort()).toEqual(['leaf1', 'leaf2'])
  })
})
