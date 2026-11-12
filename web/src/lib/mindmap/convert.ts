import { db } from '../../db/db'
import { now } from '../id'
import { parseQuickAdd } from '../quickAdd'
import { subtreeIds } from '../okr'
import type { ID, Todo } from '../../types'
import { isDescendant } from './cycle'
import { indexByParent, isLeafTodo, isLive } from './leaf'
import { buildTask } from './createTask'
import type { MeOperation, MindmapNodeMeta, TodoOp } from './types'
import { captureAndPushPatchUndo } from './undoStack'
import { evictIfPresent } from './todaySlots'

/** Waiting 节点在画布上的显示后缀（拼接 / 剥离必须同源） */
export const WAITING_SUFFIX = ' · Waiting'

export type MENode = {
  id: string
  topic: string
  children?: MENode[]
  expanded?: boolean
  style?: Record<string, string>
  /** ME 原生节点标签（渲染成小 chip）：关联人 / 完成日期 */
  tags?: string[]
  metadata?: MindmapNodeMeta
}

export type MEData = { nodeData: MENode; direction?: 0 | 1 | 2 | 3 }

const DONE_PREFIX = 'done-group:'

function isSyntheticId(id: string): boolean {
  return id.startsWith(DONE_PREFIX)
}

/** Todo 树 → Mind Elixir 数据（含 done 折叠合成节点） */
export function todosToMindData(
  all: Todo[],
  rootId: ID,
  _opts?: { hideDone?: boolean },
): MEData {
  const byParent = indexByParent(all)
  const root = all.find((t) => t.id === rootId && isLive(t))
  if (!root) {
    return {
      direction: 1,
      nodeData: {
        id: rootId,
        topic: '（空图）',
        metadata: { todoId: rootId, status: 'open', isLeaf: true },
      },
    }
  }

  const build = (t: Todo): MENode => {
    const kids = [...(byParent.get(t.id) ?? [])].sort((a, b) => a.sort_order - b.sort_order)
    const openKids = kids.filter((k) => k.status !== 'done')
    const doneKids = kids.filter((k) => k.status === 'done')
    const children: MENode[] = openKids.map(build)
    if (doneKids.length > 0) {
      children.push({
        id: `${DONE_PREFIX}${t.id}`,
        topic: `已完成 (${doneKids.length})`,
        expanded: false,
        metadata: {
          todoId: t.id,
          status: 'done',
          isLeaf: false,
          synthetic: 'done-group',
        },
        children: doneKids.map((d) => ({
          id: d.id,
          topic: d.title || '未命名',
          style: { textDecoration: 'line-through', color: 'var(--text-3, #8e8e93)' },
          // 完成项：关联人 + 完成日期 —— 「谁 · 什么时候 · 完成了什么」
          tags: [d.assignee ? `@${d.assignee}` : undefined, d.completed_at ? `完成 ${d.completed_at.slice(5, 10).replace('-', '/')}` : undefined].filter(
            (x): x is string => Boolean(x),
          ),
          metadata: {
            todoId: d.id,
            status: d.status,
            due_date: d.due_date,
            completed_at: d.completed_at,
            assignee: d.assignee,
            waiting_reason: d.waiting_reason,
            meeting_id: d.meeting_id,
            isLeaf: true,
          },
        })),
      })
    }
    const waiting = Boolean(t.waiting_reason && t.status === 'open')
    const topic = waiting
      ? `${t.title || '未命名'}${WAITING_SUFFIX}`
      : t.title || '未命名'
    return {
      id: t.id,
      topic,
      expanded: true,
      tags: t.assignee ? [`@${t.assignee}`] : undefined,
      children: children.length ? children : undefined,
      style: waiting
        ? { opacity: '0.82', fontStyle: 'italic', color: 'var(--warning, #c77c2a)' }
        : undefined,
      metadata: {
        todoId: t.id,
        status: t.status,
        due_date: t.due_date,
        completed_at: t.completed_at,
        assignee: t.assignee,
        waiting_reason: t.waiting_reason,
        meeting_id: t.meeting_id,
        isLeaf: isLeafTodo(t, byParent),
      },
    }
  }

  return { direction: 1, nodeData: build(root) }
}

function bump(t: Todo, patch: Partial<Todo>): Partial<Todo> {
  return { ...patch, updated_at: now(), sync_version: t.sync_version + 1 }
}

function newTask(
  partial: Partial<Todo> & { parent_id: ID; map_id: ID; title: string; id?: ID },
): Todo {
  return buildTask({
    id: partial.id,
    title: partial.title,
    placement: { parentId: partial.parent_id, mapId: partial.map_id },
    sortOrder: typeof partial.sort_order === 'number' ? partial.sort_order : undefined,
  })
}

/**
 * ME operation → TodoOp[]。忽略 synthetic / 未知事件。
 * ctx.mapId = 当前图根 id。
 */
export function mindEventToTodoPatches(
  ev: MeOperation,
  ctx: { all: Todo[]; mapId: ID; byId: Map<ID, Todo> },
): TodoOp[] {
  const { all, mapId, byId } = ctx

  if (ev.name === 'finishEdit') {
    if (isSyntheticId(ev.target.id)) return []
    const cur = byId.get(ev.target.id)
    if (!cur) return []
    let title = ev.target.topic
    // Waiting 节点的画布标题是「标题 · Waiting」拼出来的显示串 ——
    // 回写前必须剥掉后缀，否则编辑一次就把「 · Waiting」固化进数据
    if (cur.waiting_reason && cur.status === 'open' && title.endsWith(WAITING_SUFFIX)) {
      title = title.slice(0, -WAITING_SUFFIX.length)
    }
    // 与快速录入同口径（parseQuickAdd）：节点里直接写
    // 「写方案 @张三 明天」→ 自动识别负责人和截止日期，标题只留事。
    // 不写则不碰：只在解析出结果时覆盖对应字段，不清空已有值。
    const parsed = parseQuickAdd(title)
    const patch: Partial<Todo> = {}
    if (parsed.title !== cur.title) patch.title = parsed.title
    if (parsed.assignee && parsed.assignee !== cur.assignee) patch.assignee = parsed.assignee
    if (parsed.due_date && parsed.due_date !== cur.due_date) patch.due_date = parsed.due_date
    // 什么都没变：不进编辑态兜了一圈，不落库
    if (Object.keys(patch).length === 0) return []
    return [{ op: 'update', id: cur.id, patch: bump(cur, patch) }]
  }

  if (ev.name === 'addChild') {
    if (isSyntheticId(ev.target.id)) return []
    const parentId = ev.target.parent?.id ?? mapId
    if (isSyntheticId(parentId)) return []
    const resolvedParent =
      parentId === mapId && !byId.get(parentId) ? mapId : parentId
    const todo = newTask({
      parent_id: resolvedParent,
      map_id: mapId,
      title: ev.target.topic || '',
      id: ev.target.id,
    })
    return [{ op: 'add', todo }]
  }

  if (ev.name === 'insertSibling') {
    if (isSyntheticId(ev.target.id)) return []
    const parentId = ev.target.parent?.id ?? mapId
    const todo = newTask({
      parent_id: parentId,
      map_id: mapId,
      title: ev.target.topic || '',
      id: ev.target.id,
      sort_order: Date.now(),
    })
    return [{ op: 'add', todo }]
  }

  if (ev.name === 'insertParent') {
    if (isSyntheticId(ev.target.id)) return []
    const parentId = ev.target.parent?.id ?? mapId
    const todo = newTask({
      parent_id: parentId,
      map_id: mapId,
      title: ev.target.topic || '',
      id: ev.target.id,
    })
    return [{ op: 'add', todo }]
  }

  if (ev.name === 'removeNodes') {
    const ops: TodoOp[] = []
    for (const n of ev.target) {
      if (isSyntheticId(n.id)) continue
      if (!byId.has(n.id)) continue
      ops.push({ op: 'softDeleteSubtree', rootId: n.id })
    }
    return ops
  }

  if (ev.name === 'moveNodesIn' || ev.name === 'moveNodesBefore' || ev.name === 'moveNodesAfter') {
    const dest = ev.destination
    if (isSyntheticId(dest.id)) return []
    const ops: TodoOp[] = []
    for (const n of ev.target) {
      if (isSyntheticId(n.id)) continue
      const cur = byId.get(n.id)
      if (!cur) continue
      if (isDescendant(n.id, dest.id, byId)) continue
      let parent_id: ID | null
      let sort_order = Date.now()
      if (ev.name === 'moveNodesIn') {
        parent_id = dest.id
        const kids = all.filter((t) => t.parent_id === dest.id && isLive(t))
        sort_order = Math.max(0, ...kids.map((k) => k.sort_order)) + 10
      } else {
        // 同级插入取前后邻居中点（与 TodosTree 拖拽同口径）；
        // 之前用 anchor ± 1，多次穿插后 sort_order 撞号、顺序漂移
        parent_id = dest.parent?.id ?? mapId
        const anchor = byId.get(dest.id)
        const anchorOrder = anchor?.sort_order ?? Date.now()
        const sibs = all
          .filter((t) => t.parent_id === parent_id && isLive(t) && t.id !== n.id)
          .sort((a, b) => a.sort_order - b.sort_order)
        const aidx = sibs.findIndex((s) => s.id === dest.id)
        if (ev.name === 'moveNodesAfter') {
          const next = aidx >= 0 ? sibs[aidx + 1] : undefined
          sort_order = next ? (anchorOrder + next.sort_order) / 2 : anchorOrder + 10
        } else {
          const prevSib = aidx > 0 ? sibs[aidx - 1] : undefined
          sort_order = prevSib ? (prevSib.sort_order + anchorOrder) / 2 : anchorOrder - 10
        }
      }
      const newMap = parent_id ? (byId.get(parent_id)?.map_id ?? parent_id) : mapId
      ops.push({ op: 'update', id: n.id, patch: bump(cur, { parent_id, map_id: newMap, sort_order }) })
      for (const sid of subtreeIds(n.id, all)) {
        if (sid === n.id) continue
        const child = byId.get(sid)
        if (child) ops.push({ op: 'update', id: sid, patch: bump(child, { map_id: newMap }) })
      }
    }
    return ops
  }

  return []
}

/** 应用补丁；软删与列表 / localApi 同口径（只置 deleted_at，不动 status）；事后踢 Today 槽 */
export async function applyTodoPatches(
  ops: TodoOp[],
  opts?: { recordUndo?: boolean; scope?: string },
): Promise<void> {
  if (ops.length === 0) return
  const recordUndo = opts?.recordUndo ?? true
  if (recordUndo) await captureAndPushPatchUndo(ops, opts?.scope)
  const evictIds: string[] = []
  await db.transaction('rw', db.todos, db.tagBindings, async () => {
    for (const op of ops) {
      if (op.op === 'add') {
        await db.todos.add(op.todo)
        if (op.todo.parent_id) evictIds.push(op.todo.parent_id)
      } else if (op.op === 'update') {
        await db.todos.update(op.id, op.patch)
        if (op.patch.status === 'done') evictIds.push(op.id)
        if (op.patch.waiting_reason) evictIds.push(op.id)
      } else if (op.op === 'softDeleteSubtree') {
        const all = await db.todos.toArray()
        const ids = [...subtreeIds(op.rootId, all)]
        const ts = now()
        for (const id of ids) {
          // 只置 deleted_at：status 是任务自己的状态，删除不该篡改
          // （否则刷新页面后无法恢复，且「已归档」视图混进被删的东西）
          await db.todos.update(id, { deleted_at: ts, updated_at: ts })
          evictIds.push(id)
        }
        const bindings = await db.tagBindings
          .where('target_type')
          .equals('todo')
          .and((b) => ids.includes(b.target_id) && b.deleted_at === null)
          .toArray()
        for (const b of bindings) {
          await db.tagBindings.update(b.id, { deleted_at: ts, updated_at: ts })
        }
      }
    }
  })
  for (const id of [...new Set(evictIds)]) {
    await evictIfPresent(id)
  }
}
