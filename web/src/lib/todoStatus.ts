import { db } from '../db/db'
import { now } from './id'
import { purgeIneligibleSlots } from './mindmap/todaySlots'
import type { Todo, TodoStatus } from '../types'

/**
 * 统一「改状态」的口径，顺手把完成日期记上。
 *
 * 之前完成动作散在 8 处（列表 / 大纲 / 看板 / Today / 脑图 / 笔记 / AI / 本地 API），
 * 各自 update(status)，谁也没记「什么时候完成的」—— 想串一条完成记录出来时，
 * 根本无从下手。收口到这里：改状态 = 改状态 + 写完成时间。
 */
export async function applyTodoStatus(t: Todo, next: TodoStatus): Promise<number> {
  if (t.status === next) return 0
  const ts = now()
  const patch: Partial<Todo> = {
    status: next,
    updated_at: ts,
    sync_version: t.sync_version + 1,
  }
  if (next === 'done') {
    // 完成：记完成时间
    patch.completed_at = ts
    patch.archived_at = null
  } else if (next === 'cancelled') {
    // 归档（这件事黄了 / 被否了）：
    //   ① 记归档时间 —— 什么时候撤下的
    //   ② 没完成过的也给个「结束时间」—— 关闭了就得有时间，不能是空的
    patch.archived_at = ts
    patch.completed_at = t.completed_at ?? ts
  } else {
    // 回到 open：完成时间 / 归档时间都清掉（重新开张）
    patch.completed_at = null
    patch.archived_at = null
  }
  const n = await db.todos.update(t.id, patch)
  // 状态一变，Today 槽位可能要清（完成 / 归档的条目不再占坑）。
  // purgeIneligibleSlots 之前写好了却没人调 —— 挂在这儿，统一收口。
  void purgeIneligibleSlots().catch(() => undefined)
  return n
}

/**
 * 归档一条待办（被否 / 黄了）：从活物变成「已关闭的记录」。
 * 归档之后它不再出现在进行中的视图里，但记录还在，带归档时间。
 */
export async function archiveTodo(t: Todo): Promise<void> {
  await applyTodoStatus(t, 'cancelled')
}

/** 取消归档：回到它关闭前的状态（完成过的回到完成，其余回到待办） */
export async function unarchiveTodo(t: Todo): Promise<void> {
  // 重新读一次：传进来的快照可能是归档前的（status 还是 open），
  // 直接拿它算状态会以为「没变化」而什么都不做。
  const cur = (await db.todos.get(t.id)) ?? t
  const ts = now()
  // 归档时如果它从没完成过，我们会拿归档时间补一个「结束时间」——
  // 于是 completed_at === archived_at 就说明「它是被否掉的，不是做完的」。
  const doneBeforeArchive = Boolean(cur.completed_at) && cur.completed_at !== cur.archived_at
  await db.todos.update(t.id, {
    status: doneBeforeArchive ? 'done' : 'open',
    archived_at: null,
    completed_at: doneBeforeArchive ? cur.completed_at ?? null : null,
    updated_at: ts,
    sync_version: cur.sync_version + 1,
  })
}

/** 只读：这条有没有完成记录 */
export function completedDate(t: Pick<Todo, 'completed_at'>): string | null {
  return t.completed_at ? t.completed_at.slice(0, 10) : null
}
