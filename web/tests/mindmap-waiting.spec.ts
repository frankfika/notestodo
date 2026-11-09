import { test, expect } from '@playwright/test'
import { todosToMindData } from '../src/lib/mindmap/convert'
import { todayEligible, indexByParent } from '../src/lib/mindmap/leaf'
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

test.describe('waiting on canvas', () => {
  test('waiting_reason 渲染为 tags，且不可入 Today', () => {
    const all = [t('root', null), t('leaf', 'root', { waiting_reason: '等设计' })]
    const node = todosToMindData(all, 'root').nodeData.children?.[0]
    expect(node?.tags?.[0]).toMatchObject({ text: 'Waiting · 等设计', className: 'mindmap-tag-waiting' })
    expect(node?.style?.color).toBeDefined()
    const by = indexByParent(all)
    expect(todayEligible(all[1], by)).toBe(false)
  })

  test('清除 waiting 后可入 Today', () => {
    const open = t('leaf', 'root')
    const by = indexByParent([t('root', null), open])
    expect(todayEligible(open, by)).toBe(true)
  })
})
