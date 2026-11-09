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
