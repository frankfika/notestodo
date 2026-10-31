import type { TagBinding, Todo } from '../../types'

export interface TodoFilter {
  q: string
  status: 'active' | 'done' | 'all'
  tagIds: string[]
}

export const EMPTY_FILTER: TodoFilter = { q: '', status: 'active', tagIds: [] }

export function buildTagByTodo(bindings: TagBinding[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const b of bindings) {
    if (b.target_type !== 'todo' || b.deleted_at !== null) continue
    m.set(b.target_id, [...(m.get(b.target_id) ?? []), b.tag_id])
  }
  return m
}

export function passFilter(t: Todo, f: TodoFilter, tagByTodo: Map<string, string[]>): boolean {
  if (f.status === 'active' && t.status === 'done') return false
  if (f.status === 'done' && t.status !== 'done') return false
  if (f.q && !t.title.toLowerCase().includes(f.q.trim().toLowerCase())) return false
  if (f.tagIds.length > 0) {
    const tags = tagByTodo.get(t.id) ?? []
    if (!f.tagIds.every((id) => tags.includes(id))) return false
  }
  return true
}

/** 树视图过滤：命中的节点 + 其所有祖先（保持树结构不断裂） */
export function filterForTree(all: Todo[], f: TodoFilter, tagByTodo: Map<string, string[]>): Todo[] {
  const matched = new Set(all.filter((t) => passFilter(t, f, tagByTodo)).map((t) => t.id))
  const byId = new Map(all.map((t) => [t.id, t]))
  for (const id of [...matched]) {
    let p = byId.get(id)?.parent_id
    const seen = new Set<string>()
    while (p && !matched.has(p) && !seen.has(p)) {
      seen.add(p)
      matched.add(p)
      p = byId.get(p)?.parent_id ?? null
    }
  }
  return all.filter((t) => matched.has(t.id))
}

/** 组内排序：未完成在前，再按截止日期、sort_order */
export function doneLast(a: Todo, b: Todo): number {
  return Number(a.status === 'done') - Number(b.status === 'done')
}
