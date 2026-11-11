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
 *
 * 撤销条目带 scope（一般是图根 id；Today 槽位操作用 'today'）：
 * 之前在全局单栈里混放，看着图 B 按 ⌘Z 撤销的可能是图 A 的操作，
 * 画面上毫无反馈 —— 现在 undoMindmap(scope) 只回退本图 / Today 的条目。
 */

const MAX_DEPTH = 50

type UndoEntry = {
  label: string
  scope: string
  run: () => Promise<void>
}

const stack: UndoEntry[] = []

let mindmapEditing = false

export function setMindmapEditing(editing: boolean): void {
  mindmapEditing = editing
}

/** 编辑态唯一事实源（ME bus 的 beginEdit / finishEdit 维护） */
export function isMindmapEditing(): boolean {
  return mindmapEditing
}

export function canUndoMindmap(scope?: string): boolean {
  return stack.some((e) => matchScope(e, scope))
}

export function peekMindmapUndoLabel(scope?: string): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (matchScope(stack[i]!, scope)) return stack[i]!.label
  }
  return null
}

function matchScope(e: UndoEntry, scope?: string): boolean {
  if (!scope) return true
  return e.scope === scope || e.scope === 'today' || e.scope === 'global'
}

export function pushMindmapUndo(run: () => Promise<void>, label: string, scope = 'global'): void {
  stack.push({ label, scope, run })
  if (stack.length > MAX_DEPTH) stack.shift()
}

/** 只回退本 scope（或 Today）的最近一条；scope 缺省时回退全局最近一条 */
export async function undoMindmap(scope?: string): Promise<boolean> {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!matchScope(stack[i]!, scope)) continue
    const [entry] = stack.splice(i, 1)
    await entry!.run()
    return true
  }
  return false
}

export function clearMindmapUndoStack(): void {
  stack.length = 0
}

/** 恢复 Today 到操作前快照 */
export function pushTodayStateUndo(before: TodayState, label: string): void {
  pushMindmapUndo(async () => {
    await setToday(before)
  }, label, 'today')
}

/**
 * Space 切换完成态的撤销。
 * 完成会触发槽位清扫把任务踢出 Today —— 撤销必须把槽位快照一起还回来，
 * 否则「撤销完成」后任务从今天的执行清单里凭空消失。
 */
export function pushTodoStatusUndo(
  todoId: ID,
  previousStatus: TodoStatus,
  scope: string,
  todayBefore?: TodayState,
): void {
  pushMindmapUndo(async () => {
    const cur = await db.todos.get(todoId)
    if (cur) {
      await db.todos.update(todoId, {
        status: previousStatus,
        updated_at: now(),
        sync_version: cur.sync_version + 1,
      })
    }
    if (todayBefore) await setToday(todayBefore)
  }, '切换完成状态', scope)
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
      // 撤销「添加」要删整棵子树：只删该节点会让撤销期间新增的孩子 parent_id 悬空
      for (const id of addedIds) {
        const nowAll = await db.todos.toArray()
        await db.todos.bulkDelete([...subtreeIds(id, nowAll)])
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

export async function captureAndPushPatchUndo(ops: TodoOp[], scope = 'global'): Promise<void> {
  const undo = await createUndoForPatches(ops)
  if (undo) pushMindmapUndo(undo, labelForOps(ops), scope)
}
