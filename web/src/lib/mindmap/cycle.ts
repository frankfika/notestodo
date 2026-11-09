import type { Todo } from '../../types'

/**
 * 从 TodosTree.tsx 抽出（a6ea2e92 L45–54）。
 * 若把 nodeId 拖到 maybeAncestorId 会成环，则返回 true。
 */
export function isDescendant(
  nodeId: string,
  maybeAncestorId: string,
  byId: Map<string, Todo>,
): boolean {
  let p = byId.get(maybeAncestorId)?.parent_id
  const seen = new Set<string>()
  while (p && !seen.has(p)) {
    if (p === nodeId) return true
    seen.add(p)
    p = byId.get(p)?.parent_id ?? null
  }
  return false
}
