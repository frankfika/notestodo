import type { ID, Todo } from '../../types'

export function isLive(t: Todo): boolean {
  return t.deleted_at === null && t.status !== 'cancelled'
}

/** 只收活节点，按 parent_id 分组 */
export function indexByParent(all: Todo[]): Map<ID | null, Todo[]> {
  const m = new Map<ID | null, Todo[]>()
  for (const t of all) {
    if (!isLive(t)) continue
    const k = t.parent_id
    const arr = m.get(k)
    if (arr) arr.push(t)
    else m.set(k, [t])
  }
  return m
}

/** 未删未取消的孩子（含 done —— 用于判定是否仍是结构节点） */
export function liveChildrenOf(id: ID, byParent: Map<ID | null, Todo[]>): Todo[] {
  return byParent.get(id) ?? []
}

/** 叶子 = 没有任何活孩子 */
export function isLeafTodo(t: Todo, byParent: Map<ID | null, Todo[]>): boolean {
  return liveChildrenOf(t.id, byParent).length === 0
}

/** 可入 Today：open + 无 Waiting + 叶子 */
export function todayEligible(t: Todo, byParent: Map<ID | null, Todo[]>): boolean {
  return isLive(t) && t.status === 'open' && !t.waiting_reason && isLeafTodo(t, byParent)
}
