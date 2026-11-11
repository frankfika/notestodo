import { test, expect } from '@playwright/test'
import { mindEventToTodoPatches, todosToMindData } from '../src/lib/mindmap/convert'
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

test.describe('todosToMindData', () => {
  test('done 孩子进 done-group 合成节点且不进开放 children 主链', () => {
    const all = [t('root', null), t('open1', 'root'), t('done1', 'root', { status: 'done' })]
    const data = todosToMindData(all, 'root')
    const kids = data.nodeData.children ?? []
    expect(kids.some((c) => c.id === 'open1')).toBe(true)
    const group = kids.find((c) => c.id === 'done-group:root')
    expect(group?.metadata?.synthetic).toBe('done-group')
    expect(group?.children?.[0]?.id).toBe('done1')
    expect(kids.some((c) => c.id === 'done1')).toBe(false)
  })

  test('节点使用 metadata 而非 data 字段', () => {
    const all = [t('root', null)]
    const node = todosToMindData(all, 'root').nodeData
    expect(node.metadata?.todoId).toBe('root')
    expect((node as { data?: unknown }).data).toBeUndefined()
  })
})

test.describe('mindEventToTodoPatches', () => {
  test('finishEdit 更新标题；done-group 不写回', () => {
    const all = [t('root', null)]
    const byId = new Map(all.map((x) => [x.id, x]))
    const ops = mindEventToTodoPatches(
      { name: 'finishEdit', target: { id: 'root', topic: '新标题' }, origin: 'main' },
      { all, mapId: 'root', byId },
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].op === 'update' && ops[0].patch.title).toBe('新标题')

    const noop = mindEventToTodoPatches(
      { name: 'finishEdit', target: { id: 'done-group:root', topic: 'x' }, origin: 'main' },
      { all, mapId: 'root', byId },
    )
    expect(noop).toHaveLength(0)
  })

  test('finishEdit：Waiting 节点回写时剥掉「 · Waiting」显示后缀', () => {
    const all = [t('root', null), t('w1', 'root', { title: '催设计稿', waiting_reason: '等设计' })]
    const byId = new Map(all.map((x) => [x.id, x]))
    // 用户在画布里把「催设计稿 · Waiting」改成「催设计稿和文案 · Waiting」
    const ops = mindEventToTodoPatches(
      { name: 'finishEdit', target: { id: 'w1', topic: '催设计稿和文案 · Waiting' }, origin: 'main' },
      { all, mapId: 'root', byId },
    )
    expect(ops).toHaveLength(1)
    // 后缀不能固化进数据，否则下次渲染变成「… · Waiting · Waiting」
    expect(ops[0].op === 'update' && ops[0].patch.title).toBe('催设计稿和文案')

    // 开了编辑但没改（ME 只在变化时触发，但双保险）：显示串归一化后同题 → 不落库
    const noop = mindEventToTodoPatches(
      { name: 'finishEdit', target: { id: 'w1', topic: '催设计稿 · Waiting' }, origin: 'main' },
      { all, mapId: 'root', byId },
    )
    expect(noop).toHaveLength(0)
  })

  test('addChild 生成 add op', () => {
    const all = [t('root', null)]
    const byId = new Map(all.map((x) => [x.id, x]))
    const ops = mindEventToTodoPatches(
      { name: 'addChild', target: { id: 'child1', topic: '子任务', parent: { id: 'root' } } },
      { all, mapId: 'root', byId },
    )
    expect(ops).toHaveLength(1)
    expect(ops[0].op === 'add' && ops[0].todo.id).toBe('child1')
    expect(ops[0].op === 'add' && ops[0].todo.parent_id).toBe('root')
  })

  test('moveNodesIn 成环时跳过', () => {
    const all = [t('root', null), t('a', 'root'), t('b', 'a')]
    const byId = new Map(all.map((x) => [x.id, x]))
    const ops = mindEventToTodoPatches(
      {
        name: 'moveNodesIn',
        target: [{ id: 'root' }],
        destination: { id: 'b' },
      },
      { all, mapId: 'root', byId },
    )
    expect(ops).toHaveLength(0)
  })

  test('moveNodesIn 合法移动更新 parent', () => {
    const all = [t('root', null), t('a', 'root'), t('b', 'root')]
    const byId = new Map(all.map((x) => [x.id, x]))
    const ops = mindEventToTodoPatches(
      {
        name: 'moveNodesIn',
        target: [{ id: 'b' }],
        destination: { id: 'a' },
      },
      { all, mapId: 'root', byId },
    )
    expect(ops.some((o) => o.op === 'update' && o.id === 'b' && o.patch.parent_id === 'a')).toBe(true)
  })
})
