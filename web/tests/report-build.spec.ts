import { test, expect } from '@playwright/test'
import { buildReport } from '../src/pages/report/ReportPage'
import { thisFriday } from '../src/lib/id'
import type { Todo } from '../src/types'

const mk = (o: Partial<Todo>): Todo => ({
  id: o.id ?? Math.random().toString(36).slice(2), kind: 'task', parent_id: null, scope: null,
  title: '', status: 'open', source: 'manual', sort_order: 0,
  created_at: '2026-10-13T09:00:00.000Z', updated_at: '2026-10-13T09:00:00.000Z',
  deleted_at: null, sync_version: 0, ...o,
}) as Todo

test('buildReport 按 KR 归组本周已完成卡片，排除上周与软删', () => {
  const range = { start: new Date(2026, 9, 12), end: new Date(2026, 9, 19) } // 10/12–10/18
  const todos = [
    mk({ id: 'kr1', kind: 'kr', scope: 'quarterly', title: '完成 100 场访谈' }),
    mk({ id: 't1', parent_id: 'kr1', title: '约访 5 人', status: 'done', updated_at: '2026-10-15T02:00:00.000Z' }),
    mk({ id: 't2', title: '上周做的', status: 'done', updated_at: '2026-10-05T02:00:00.000Z' }),
    mk({ id: 't3', title: '已删除', status: 'done', updated_at: '2026-10-15T02:00:00.000Z', deleted_at: '2026-10-16T00:00:00.000Z' }),
    mk({ id: 't4', title: '逾期的', due_date: '2026-10-01' }),
  ]
  const todayStr = '2026-10-16'
  const out = buildReport(todos, [{ title: '产品评审会', started_at: '2026-10-14T06:00:00.000Z' }], range, todayStr)
  expect(out).toContain('完成 1 张卡片，开了 1 场会议')
  expect(out).toContain('完成 100 场访谈')
  expect(out).toContain('约访 5 人')
  expect(out).not.toContain('上周做的')
  expect(out).not.toContain('已删除')
  expect(out).toContain('逾期') // 风险区列出逾期
  expect(out).toContain('产品评审会')
})

test('thisFriday 落在当周周五且为周五', () => {
  const f = thisFriday(new Date(2026, 9, 14)) // 周三
  expect(f).toBe('2026-10-16')
  expect(new Date(f + 'T00:00:00').getDay()).toBe(5)
})
