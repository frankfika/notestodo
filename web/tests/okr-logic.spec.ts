/**
 * 嵌套 OKR 纯逻辑：父子规则 / 进度汇总 / 季度工具 / KR 建议。无需浏览器。
 */
import { test, expect } from '@playwright/test'
import { canParent, currentPeriod, rollupProgress, shiftPeriod, periodRange, suggestKr, subtreeIds } from '../src/lib/okr'
import type { Todo } from '../src/types'

function t(id: string, kind: Todo['kind'], scope: Todo['scope'], parent: string | null, extra: Partial<Todo> = {}): Todo {
  return {
    id, kind, scope, parent_id: parent, title: id, status: 'open', source: 'manual', sort_order: 0,
    created_at: '', updated_at: '', deleted_at: null, sync_version: 0, ...extra,
  }
}

test('parent rules', () => {
  const sO = t('sO', 'objective', 'strategic', null)
  const sKR = t('sKR', 'kr', 'strategic', 'sO')
  const qO = t('qO', 'objective', 'quarterly', 'sKR')
  const qKR = t('qKR', 'kr', 'quarterly', 'qO')
  const pO = t('pO', 'objective', 'project', 'qKR')
  const pKR = t('pKR', 'kr', 'project', 'pO')
  expect(canParent(sO, null)).toBe(true)
  expect(canParent(sO, sKR)).toBe(false)
  expect(canParent(sKR, sO)).toBe(true)
  expect(canParent(sKR, null)).toBe(false)
  expect(canParent(qO, sKR)).toBe(true)
  expect(canParent(qO, sO)).toBe(false)
  expect(canParent(qKR, qO)).toBe(true)
  expect(canParent(pO, qKR)).toBe(true)
  expect(canParent(pO, sKR)).toBe(false)
  expect(canParent(pKR, pO)).toBe(true)
  const task = { kind: 'task' as const, scope: null }
  for (const kr of [sKR, qKR, pKR]) expect(canParent(task, kr)).toBe(true)
  expect(canParent(task, null)).toBe(true)
  expect(canParent(task, pO)).toBe(false)
})

test('progress rolls up with weights; pending_review ignored', () => {
  const todos = [
    t('O', 'objective', 'strategic', null),
    t('KR1', 'kr', 'strategic', 'O', { weight: 0.75 }),
    t('KR2', 'kr', 'strategic', 'O', { weight: 0.25 }),
    t('a', 'task', 'strategic', 'KR1', { status: 'done' }),
    t('b', 'task', 'strategic', 'KR1'),
    t('c', 'task', 'strategic', 'KR2', { status: 'done' }),
    t('d', 'task', 'strategic', 'KR2', { status: 'pending_review' }),
  ]
  const p = rollupProgress(todos)
  expect(p.get('KR1')).toBe(0.5)
  expect(p.get('KR2')).toBe(1)
  expect(p.get('O')).toBeCloseTo(0.75 * 0.5 + 0.25 * 1)
  expect([...subtreeIds('KR2', todos)].sort()).toEqual(['KR2', 'c', 'd'])
})

test('periods', () => {
  expect(currentPeriod(new Date(2026, 9, 12))).toBe('2026-Q4')
  expect(shiftPeriod('2026-Q4', 1)).toBe('2027-Q1')
  expect(shiftPeriod('2026-Q1', -1)).toBe('2025-Q4')
  expect(periodRange('2026-Q1')).toEqual(['2026-01-01', '2026-03-31'])
})

test('suggestKr picks closest open KR', () => {
  const todos = [
    t('k1', 'kr', 'project', null, { title: '完成法务合同审核' }),
    t('k2', 'kr', 'project', null, { title: 'Q4 预算上线' }),
  ]
  expect(suggestKr('跟法务确认合同条款', todos)?.id).toBe('k1')
  expect(suggestKr('买咖啡', todos)).toBeNull()
})
