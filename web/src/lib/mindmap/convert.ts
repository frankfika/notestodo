import { db } from '../../db/db'
import { now, uid } from '../id'
import { subtreeIds } from '../okr'
import type { ID, Todo } from '../../types'
import { isDescendant } from './cycle'
import { indexByParent, isLeafTodo, isLive } from './leaf'
import type { MeOperation, MindmapNodeMeta, TodoOp } from './types'
import { captureAndPushPatchUndo } from './undoStack'
import { evictIfPresent } from './todaySlots'

export type MENode = {
  id: string
  topic: string
  children?: MENode[]
  expanded?: boolean
  style?: Record<string, string>
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
          metadata: {
            todoId: d.id,
            status: d.status,
            due_date: d.due_date,
            waiting_reason: d.waiting_reason,
            meeting_id: d.meeting_id,
            isLeaf: true,
          },
        })),
      })
    }
    const waiting = Boolean(t.waiting_reason && t.status === 'open')
    const topic = waiting
      ? `${t.title || '未命名'} · Waiting`
      : t.title || '未命名'
    return {
      id: t.id,
      topic,
      expanded: true,
      children: children.length ? children : undefined,
      style: waiting
        ? { opacity: '0.82', fontStyle: 'italic', color: 'var(--warning, #c77c2a)' }
        : undefined,
      metadata: {
        todoId: t.id,
        status: t.status,
        due_date: t.due_date,
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
  partial: Partial<Todo> & { parent_id: ID | null; map_id: ID; title: string; id?: ID },
): Todo {
  const ts = now()
  return {
    id: partial.id ?? uid(),
    kind: 'task',
    scope: null,
    status: 'open',
    source: 'manual',
    sort_order: Date.now(),
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
    sync_version: 0,
    ...partial,
  }
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
    return [{ op: 'update', id: cur.id, patch: bump(cur, { title: ev.target.topic }) }]
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
        parent_id = dest.parent?.id ?? mapId
        const anchor = byId.get(dest.id)
        sort_order = (anchor?.sort_order ?? Date.now()) + (ev.name === 'moveNodesAfter' ? 1 : -1)
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

/** 应用补丁；软删复刻 localApi DELETE；事后踢 Today 槽 */
export async function applyTodoPatches(
  ops: TodoOp[],
  opts?: { recordUndo?: boolean },
): Promise<void> {
  if (ops.length === 0) return
  const recordUndo = opts?.recordUndo ?? true
  if (recordUndo) await captureAndPushPatchUndo(ops)
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
          await db.todos.update(id, { deleted_at: ts, updated_at: ts, status: 'cancelled' })
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
