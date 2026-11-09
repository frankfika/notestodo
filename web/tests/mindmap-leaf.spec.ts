import { test, expect } from '@playwright/test'
import { indexByParent, isLeafTodo, todayEligible } from '../src/lib/mindmap/leaf'
import type { Todo } from '../src/types'

function t(id: string, parent: string | null, extra: Partial<Todo> = {}): Todo {
  return {
    id, kind: 'task', scope: null, parent_id: parent, title: id, status: 'open',
    source: 'manual', sort_order: 0, created_at: '', updated_at: '', deleted_at: null,
    sync_version: 0, ...extra,
  }
}

test.describe('leaf / todayEligible', () => {
  test('有活孩子则非叶子；无孩子可入槽', () => {
    const all = [t('root', null), t('a', 'root'), t('b', 'a')]
    const by = indexByParent(all)
    expect(isLeafTodo(all[0], by)).toBe(false)
    expect(isLeafTodo(all[2], by)).toBe(true)
    expect(todayEligible(all[2], by)).toBe(true)
    expect(todayEligible({ ...all[2], waiting_reason: '等设计' }, by)).toBe(false)
  })
})
