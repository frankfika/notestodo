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

  test('节点 tags：@负责人 + 截止 / 逾期日期', () => {
    const all = [
      t('root', null),
      t('a', 'root', { assignee: '张三', due_date: '2099-01-02' }),
      t('b', 'root', { due_date: '2020-01-02' }), // 已逾期
      t('c', 'root'), // 无负责人无日期 → 无 tags
    ]
    const kids = todosToMindData(all, 'root').nodeData.children ?? []
    expect(kids.find((c) => c.id === 'a')?.tags).toEqual(['@张三', '截止 01/02'])
    expect(kids.find((c) => c.id === 'b')?.tags).toEqual(['逾期 01/02'])
    expect(kids.find((c) => c.id === 'c')?.tags).toBeUndefined()
  })

  test('节点 tags：任务来源「✎ 笔记 / ● 会议」，排在负责人和截止之后', () => {
    const all = [
      t('root', null),
      t('a', 'root', { origin_note_id: 'n1' }),
      t('b', 'root', { meeting_id: 'm1' }),
      t('c', 'root', { assignee: '张三', due_date: '2099-01-02', origin_note_id: 'n1' }),
    ]
    const origins = {
      noteTitles: new Map([['n1', '周会纪要']]),
      meetingTitles: new Map([['m1', '对齐会']]),
    }
    const kids = todosToMindData(all, 'root', undefined, origins).nodeData.children ?? []
    expect(kids.find((c) => c.id === 'a')?.tags).toEqual(['✎ 周会纪要'])
    expect(kids.find((c) => c.id === 'b')?.tags).toEqual(['● 对齐会'])
    expect(kids.find((c) => c.id === 'c')?.tags).toEqual(['@张三', '截止 01/02', '✎ 周会纪要'])
    // 不传 origins（标题还没查回来）也给兜底标，不会出现「有来源却毫无显示」的空窗
    const kids2 = todosToMindData(all, 'root').nodeData.children ?? []
    expect(kids2.find((c) => c.id === 'a')?.tags).toEqual(['✎ 笔记'])
    expect(kids2.find((c) => c.id === 'b')?.tags).toEqual(['● 会议'])
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

  test('finishEdit：与快速录入同口径解析「@负责人 / 明天」', () => {
    const all = [t('root', null), t('a', 'root', { title: '写方案' })]
    const byId = new Map(all.map((x) => [x.id, x]))
    const ops = mindEventToTodoPatches(
      { name: 'finishEdit', target: { id: 'a', topic: '写方案 v2 @张三 明天' }, origin: 'main' },
      { all, mapId: 'root', byId },
    )
    expect(ops).toHaveLength(1)
    if (ops[0].op !== 'update') throw new Error('unreachable')
    expect(ops[0].patch.title).toBe('写方案 v2')
    expect(ops[0].patch.assignee).toBe('张三')
    expect(ops[0].patch.due_date).toBeTruthy()

    // 没写 @ / 日期：已有的负责人和截止日期不被清空
    const all2 = [
      t('root', null),
      t('a', 'root', { title: '写方案 v2', assignee: '张三', due_date: '2026-11-13' }),
    ]
    const byId2 = new Map(all2.map((x) => [x.id, x]))
    const ops2 = mindEventToTodoPatches(
      { name: 'finishEdit', target: { id: 'a', topic: '写方案 v3' }, origin: 'main' },
      { all: all2, mapId: 'root', byId: byId2 },
    )
    expect(ops2).toHaveLength(1)
    if (ops2[0].op !== 'update') throw new Error('unreachable')
    expect(ops2[0].patch.title).toBe('写方案 v3')
    expect(ops2[0].patch.assignee).toBeUndefined()
    expect(ops2[0].patch.due_date).toBeUndefined()
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
