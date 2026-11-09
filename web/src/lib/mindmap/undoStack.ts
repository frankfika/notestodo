import { db } from '../../db/db'
import { now } from '../id'
import { subtreeIds } from '../okr'
import type { ID, Todo, TodoStatus } from '../../types'
import type { TagBinding } from '../../types'
import { getToday, setToday } from './todaySlots'
import type { TodayState, TodoOp } from './types'

/**
 * R4 · 失败可撤
 *
 * Mind Elixir 保持 `allowUndo: false`：ME 内置撤销只回放画布 JSON，不会写回 Dexie，
 * 也不知 Today 槽位。业务级 ⌘Z 走本模块的应用撤销栈。
 */

const MAX_DEPTH = 50

type UndoEntry = {
  label: string
  run: () => Promise<void>
}

const stack: UndoEntry[] = []

let mindmapEditing = false

export function setMindmapEditing(editing: boolean): void {
  mindmapEditing = editing
}

export function isMindmapEditing(): boolean {
  return mindmapEditing
}

export function canUndoMindmap(): boolean {
  return stack.length > 0
}

export function peekMindmapUndoLabel(): string | null {
  return stack.length ? stack[stack.length - 1]!.label : null
}

export function pushMindmapUndo(run: () => Promise<void>, label: string): void {
  stack.push({ label, run })
  if (stack.length > MAX_DEPTH) stack.shift()
}

export async function undoMindmap(): Promise<boolean> {
  const entry = stack.pop()
  if (!entry) return false
  await entry.run()
  return true
}

export function clearMindmapUndoStack(): void {
  stack.length = 0
}

/** 恢复 Today 到操作前快照 */
export function pushTodayStateUndo(before: TodayState, label: string): void {
  pushMindmapUndo(async () => {
    await setToday(before)
  }, label)
}

/** Space 切换完成态 */
export function pushTodoStatusUndo(todoId: ID, previousStatus: TodoStatus): void {
  pushMindmapUndo(async () => {
    const cur = await db.todos.get(todoId)
    if (!cur) return
    await db.todos.update(todoId, {
      status: previousStatus,
      updated_at: now(),
      sync_version: cur.sync_version + 1,
    })
  }, '切换完成状态')
}

function labelForOps(ops: TodoOp[]): string {
  const first = ops[0]
  if (!first) return '脑图编辑'
  if (first.op === 'add') return '添加节点'
  if (first.op === 'softDeleteSubtree') return '删除节点'
  if (first.op === 'update' && first.patch.title !== undefined) return '重命名'
  if (first.op === 'update' && first.patch.parent_id !== undefined) return '移动节点'
  return '脑图编辑'
}

/** 在 applyTodoPatches 之前调用，返回撤销函数 */
export async function createUndoForPatches(ops: TodoOp[]): Promise<(() => Promise<void>) | null> {
  if (ops.length === 0) return null
  const all = await db.todos.toArray()
  const byId = new Map(all.map((t) => [t.id, t]))
  const todayBefore = await getToday()

  const addedIds: ID[] = []
  const todoBackups = new Map<ID, Todo>()
  let tagBindingBackups: TagBinding[] = []

  for (const op of ops) {
    if (op.op === 'add') {
      addedIds.push(op.todo.id)
    } else if (op.op === 'update') {
      const cur = byId.get(op.id)
      if (cur) todoBackups.set(op.id, { ...cur })
    } else if (op.op === 'softDeleteSubtree') {
      const ids = [...subtreeIds(op.rootId, all)]
      for (const id of ids) {
        const cur = byId.get(id)
        if (cur) todoBackups.set(id, { ...cur })
      }
      const bindings = await db.tagBindings
        .where('target_type')
        .equals('todo')
        .and((b) => ids.includes(b.target_id))
        .toArray()
      tagBindingBackups = bindings.map((b) => ({ ...b }))
    }
  }

  if (addedIds.length === 0 && todoBackups.size === 0) return null

  return async () => {
    await db.transaction('rw', db.todos, db.tagBindings, async () => {
      for (const id of addedIds) {
        await db.todos.delete(id)
      }
      for (const t of todoBackups.values()) {
        await db.todos.put(t)
      }
      for (const b of tagBindingBackups) {
        await db.tagBindings.put(b)
      }
    })
    await setToday(todayBefore)
  }
}

export async function captureAndPushPatchUndo(ops: TodoOp[]): Promise<void> {
  const undo = await createUndoForPatches(ops)
  if (undo) pushMindmapUndo(undo, labelForOps(ops))
}
