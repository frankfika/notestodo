import type { Todo } from '../types'
import { canParent, inheritedScope, levelLabel, subtreeIds, type Level } from './okr'

/**
 * OKR 树的「移动」规则：拖拽、「移动到…」、上移 / 下移 都只走这里，保证不会挂出非法层级或成环。
 * 纯函数，返回要写库的补丁，不碰 DB。
 */

export const levelOf = (t: Pick<Todo, 'kind' | 'scope'>): Level => ({ kind: t.kind, scope: t.kind === 'task' ? null : t.scope })

const live = (t: Todo): boolean => t.deleted_at === null && t.status !== 'cancelled'

/** 节点能挂到哪些父节点（不含自己和自己的子孙）；task 还可以回 Inbox（null） */
export function validParents(node: Todo, all: Todo[]): { parents: Todo[]; rootOk: boolean } {
  const own = subtreeIds(node.id, all)
  const level = levelOf(node)
  return {
    parents: all.filter((t) => live(t) && t.status !== 'done' && !own.has(t.id) && canParent(level, t)),
    rootOk: canParent(level, null),
  }
}

/** 面包屑：从根到该节点（不含自己），用于「移动到…」里辨认同名 KR */
export function pathOf(node: Todo, byId: Map<string, Todo>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let p = node.parent_id ? byId.get(node.parent_id) : undefined
  while (p && !seen.has(p.id)) {
    seen.add(p.id)
    out.unshift(p.title)
    p = p.parent_id ? byId.get(p.parent_id) : undefined
  }
  return out
}

export type Patch = { id: string; changes: Partial<Todo> }

/** 换父节点：校验层级 + 防成环；季度节点挂到别处时沿用新父的季度 */
export function reparent(node: Todo, parent: Todo | null, all: Todo[]): Patch | { error: string } {
  const level = levelOf(node)
  if (!canParent(level, parent)) return { error: `${levelLabel(level)} 不能放在${parent ? `「${levelLabel(levelOf(parent))}」` : '最外层'}下` }
  if (parent && subtreeIds(node.id, all).has(parent.id)) return { error: '不能移到自己的下级里' }
  const changes: Partial<Todo> = { parent_id: parent?.id ?? null, scope: inheritedScope(level, parent) }
  if (node.scope === 'quarterly' && node.kind !== 'task' && parent?.period) changes.period = parent.period
  return { id: node.id, changes }
}

/** 同级排序：把 dragged 放到 target 的前 / 后；返回需要更新 sort_order 的同级节点（重排为 10、20、30…） */
export function reorder(siblings: Todo[], draggedId: string, targetId: string, where: 'before' | 'after'): Patch[] {
  const list = [...siblings].sort((a, b) => a.sort_order - b.sort_order).filter((t) => t.id !== draggedId)
  const dragged = siblings.find((t) => t.id === draggedId)
  if (!dragged) return []
  const i = list.findIndex((t) => t.id === targetId)
  if (i < 0) return []
  list.splice(where === 'before' ? i : i + 1, 0, dragged)
  return list
    .map((t, idx) => ({ id: t.id, changes: { sort_order: (idx + 1) * 10 } }))
    .filter((p) => siblings.find((t) => t.id === p.id)!.sort_order !== p.changes.sort_order)
}

/** 上移 / 下移一位（移动端没有拖拽） */
export function nudge(siblings: Todo[], id: string, dir: -1 | 1): Patch[] {
  const list = [...siblings].sort((a, b) => a.sort_order - b.sort_order)
  const i = list.findIndex((t) => t.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= list.length) return []
  return reorder(siblings, id, list[j].id, dir < 0 ? 'before' : 'after')
}

/**
 * 拖拽落点 → 操作：
 *   inside       = 挂到 target 下（target 必须能当父节点）
 *   before/after = 放到 target 同级的前 / 后（必要时一并换父）
 */
export function dropPlan(
  dragged: Todo,
  target: Todo,
  zone: 'inside' | 'before' | 'after',
  all: Todo[],
): Patch[] | { error: string } {
  if (dragged.id === target.id) return []
  if (zone === 'inside') {
    const r = reparent(dragged, target, all)
    if ('error' in r) return r
    // 挂进去 = 放到新父节点的最后（否则沿用旧的 sort_order，会和新同级撞号、位置随机）
    const last = Math.max(0, ...all.filter((t) => t.parent_id === target.id && t.id !== dragged.id).map((t) => t.sort_order))
    return [{ id: r.id, changes: { ...r.changes, sort_order: last + 10 } }]
  }
  const parent = target.parent_id ? all.find((t) => t.id === target.parent_id) ?? null : null
  const patches: Patch[] = []
  let moved = dragged
  if (dragged.parent_id !== target.parent_id) {
    const r = reparent(dragged, parent, all)
    if ('error' in r) return r
    patches.push(r)
    moved = { ...dragged, ...r.changes }
  }
  const siblings = all.filter((t) => t.parent_id === target.parent_id && t.deleted_at === null && t.id !== dragged.id).concat(moved)
  for (const p of reorder(siblings, dragged.id, target.id, zone)) {
    const existing = patches.find((x) => x.id === p.id)
    if (existing) Object.assign(existing.changes, p.changes)
    else patches.push(p)
  }
  return patches
}
