import { test, expect } from '@playwright/test'
import { dropPlan, nudge, pathOf, reorder, reparent, validParents } from '../src/lib/okrMove'
import type { Todo } from '../src/types'

let n = 0
const mk = (id: string, kind: Todo['kind'], scope: Todo['scope'], parent: string | null, extra: Partial<Todo> = {}): Todo => ({
  id, kind, scope, parent_id: parent, title: id, status: 'open', source: 'manual', notes_md: '',
  sort_order: (++n) * 10, created_at: '', updated_at: '', deleted_at: null, sync_version: 0, ...extra,
} as Todo)

const tree = (): Todo[] => {
  n = 0
  return [
    mk('O', 'objective', 'strategic', null),
    mk('KR', 'kr', 'strategic', 'O'),
    mk('QO', 'objective', 'quarterly', 'KR', { period: '2026-Q4' }),
    mk('QK1', 'kr', 'quarterly', 'QO', { period: '2026-Q4' }),
    mk('QK2', 'kr', 'quarterly', 'QO', { period: '2026-Q4' }),
    mk('t1', 'task', 'quarterly', 'QK1'),
    mk('t2', 'task', 'quarterly', 'QK1'),
    mk('t3', 'task', 'quarterly', 'QK1'),
    mk('inbox', 'task', null, null),
  ]
}

test('validParents：task 只能挂 KR 或回 Inbox；O/KR 只能挂合法层级，且不含自己的子孙', () => {
  const all = tree()
  const t = validParents(all.find((x) => x.id === 'inbox')!, all)
  expect(t.parents.map((p) => p.id).sort()).toEqual(['KR', 'QK1', 'QK2'])
  expect(t.rootOk).toBe(true)
  const qo = validParents(all.find((x) => x.id === 'QO')!, all)
  expect(qo.parents.map((p) => p.id)).toEqual(['KR'])
  expect(qo.rootOk).toBe(false)
})

test('reparent：Inbox 任务挂到季度 KR 继承 scope；非法层级与成环被拒', () => {
  const all = tree()
  const by = (id: string) => all.find((x) => x.id === id)!
  expect(reparent(by('inbox'), by('QK2'), all)).toEqual({ id: 'inbox', changes: { parent_id: 'QK2', scope: 'quarterly' } })
  expect(reparent(by('t1'), null, all)).toEqual({ id: 't1', changes: { parent_id: null, scope: null } })
  expect('error' in reparent(by('QO'), by('QK1'), all)).toBe(true) // 季度 O 不能挂季度 KR 下
  expect('error' in reparent(by('KR'), by('t1'), all)).toBe(true)
})

test('reorder / nudge：同级重排为 10、20、30，只返回变化的项', () => {
  const sib = tree().filter((t) => t.parent_id === 'QK1') // t1(60) t2(70) t3(80)
  expect(reorder(sib, 't3', 't1', 'before')).toEqual([
    { id: 't3', changes: { sort_order: 10 } }, { id: 't1', changes: { sort_order: 20 } }, { id: 't2', changes: { sort_order: 30 } },
  ])
  const up = nudge(sib, 't2', -1)
  expect(Object.fromEntries(up.map((p) => [p.id, p.changes.sort_order]))).toEqual({ t2: 10, t1: 20, t3: 30 })
  expect(nudge(sib, 't1', -1)).toEqual([]) // 已在最上
})

test('dropPlan：拖到 KR 上=挂进去；拖到别的 KR 下某任务前=换父 + 排序；非法落点返回 error', () => {
  const all = tree()
  const by = (id: string) => all.find((x) => x.id === id)!
  // QK2 下面没有子项 → 放在 10；QK1 下面已有 t1..t3（最大 80）→ 放到最后 90
  expect(dropPlan(by('inbox'), by('QK2'), 'inside', all)).toEqual([{ id: 'inbox', changes: { parent_id: 'QK2', scope: 'quarterly', sort_order: 10 } }])
  expect(dropPlan(by('inbox'), by('QK1'), 'inside', all)).toEqual([{ id: 'inbox', changes: { parent_id: 'QK1', scope: 'quarterly', sort_order: 90 } }])
  const plan = dropPlan(by('inbox'), by('t2'), 'before', all) as { id: string; changes: Partial<Todo> }[]
  const m = Object.fromEntries(plan.map((p) => [p.id, p.changes]))
  expect(m.inbox).toMatchObject({ parent_id: 'QK1', scope: 'quarterly', sort_order: 20 })
  expect(m.t2.sort_order).toBe(30)
  expect('error' in (dropPlan(by('QO'), by('t1'), 'inside', all) as object)).toBe(true)
})

test('pathOf：面包屑从根到父', () => {
  const all = tree()
  const byId = new Map(all.map((t) => [t.id, t]))
  expect(pathOf(byId.get('t1')!, byId)).toEqual(['O', 'KR', 'QO', 'QK1'])
})
