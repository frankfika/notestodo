import type { OkrScope, Todo, TodoKind } from '../types'

/**
 * 嵌套 OKR 规则（docs/FORESIGHT_OKR_REDESIGN.md §3.1）。纯函数，无 DB 依赖。
 *
 *   strategic O → strategic KR → quarterly O → quarterly KR → project O → project KR
 *   task → 任意 KR 或 null（Inbox）
 */

export interface Level { kind: TodoKind; scope: OkrScope | null }

/** 每个 O/KR 层级的合法父层级；null = 必须是根 */
const PARENT_OF: Record<string, Level | null> = {
  'objective:strategic': null,
  'kr:strategic': { kind: 'objective', scope: 'strategic' },
  'objective:quarterly': { kind: 'kr', scope: 'strategic' },
  'kr:quarterly': { kind: 'objective', scope: 'quarterly' },
  'objective:project': { kind: 'kr', scope: 'quarterly' },
  'kr:project': { kind: 'objective', scope: 'project' },
}

export const LEVELS: Level[] = [
  { kind: 'objective', scope: 'strategic' },
  { kind: 'kr', scope: 'strategic' },
  { kind: 'objective', scope: 'quarterly' },
  { kind: 'kr', scope: 'quarterly' },
  { kind: 'objective', scope: 'project' },
  { kind: 'kr', scope: 'project' },
  { kind: 'task', scope: null },
]

const SCOPE_LABEL: Record<OkrScope, string> = { strategic: '战略', quarterly: '季度', project: '项目' }

export function levelLabel(l: Level): string {
  if (l.kind === 'task') return 'Task'
  return `${SCOPE_LABEL[l.scope ?? 'strategic']} ${l.kind === 'objective' ? 'O' : 'KR'}`
}

export function canParent(child: Level, parent: Pick<Todo, 'kind' | 'scope'> | null): boolean {
  if (child.kind === 'task') return parent === null || parent.kind === 'kr'
  const want = PARENT_OF[`${child.kind}:${child.scope}`]
  if (want === undefined) return false
  if (want === null) return parent === null
  return parent !== null && parent.kind === want.kind && parent.scope === want.scope
}

/** 在某节点下「+ 子项」可创建的层级（task 总可挂 KR 下） */
export function childLevels(parent: Pick<Todo, 'kind' | 'scope'>): Level[] {
  return LEVELS.filter((l) => canParent(l, parent))
}

/** 子节点继承的 scope：task 跟随父 KR，Inbox 为 null */
export function inheritedScope(child: Level, parent: Pick<Todo, 'scope'> | null): OkrScope | null {
  return child.kind === 'task' ? (parent?.scope ?? null) : child.scope
}

export function currentPeriod(d = new Date()): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
}

export function shiftPeriod(period: string, delta: number): string {
  const m = /^(\d{4})-Q([1-4])$/.exec(period)
  if (!m) return currentPeriod()
  const idx = Number(m[1]) * 4 + Number(m[2]) - 1 + delta
  return `${Math.floor(idx / 4)}-Q${(idx % 4) + 1}`
}

/** 季度起止日 [YYYY-MM-DD, YYYY-MM-DD]（含） */
export function periodRange(period: string): [string, string] {
  const m = /^(\d{4})-Q([1-4])$/.exec(period)
  const y = m ? Number(m[1]) : new Date().getFullYear()
  const q = m ? Number(m[2]) : 1
  const p = (n: number) => String(n).padStart(2, '0')
  const lastDay = new Date(y, q * 3, 0).getDate()
  return [`${y}-${p(q * 3 - 2)}-01`, `${y}-${p(q * 3)}-${p(lastDay)}`]
}

const live = (t: Todo) => t.deleted_at === null && t.status !== 'cancelled'

export function childrenIndex(todos: Todo[]): Map<string | null, Todo[]> {
  const m = new Map<string | null, Todo[]>()
  for (const t of todos) {
    if (!live(t)) continue
    const list = m.get(t.parent_id) ?? []
    list.push(t)
    m.set(t.parent_id, list)
  }
  for (const list of m.values()) list.sort((a, b) => a.sort_order - b.sort_order)
  return m
}

/**
 * 进度汇总 0–1：task = done?1:0；O/KR = 子节点按 weight（缺省 1）加权平均；
 * 无子节点的 O/KR 按自身 done 状态。pending_review 不计入。
 */
export function rollupProgress(todos: Todo[]): Map<string, number> {
  const kids = childrenIndex(todos.filter((t) => t.status !== 'pending_review'))
  const out = new Map<string, number>()
  const visit = (t: Todo, seen: Set<string>): number => {
    const cached = out.get(t.id)
    if (cached !== undefined) return cached
    if (seen.has(t.id)) return 0 // 防御环
    seen.add(t.id)
    const ch = kids.get(t.id) ?? []
    let v: number
    if (t.kind === 'task' || ch.length === 0) {
      v = t.status === 'done' ? 1 : 0
    } else {
      let sum = 0
      let wsum = 0
      for (const c of ch) {
        const w = c.weight ?? 1
        sum += visit(c, seen) * w
        wsum += w
      }
      v = wsum > 0 ? sum / wsum : 0
    }
    out.set(t.id, v)
    return v
  }
  for (const t of todos) if (live(t)) visit(t, new Set())
  return out
}

/** 沿祖先链找第一个 period（quarterly 节点携带） */
export function periodOf(t: Todo, byId: Map<string, Todo>): string | undefined {
  let cur: Todo | undefined = t
  for (let i = 0; cur && i < 10; i++) {
    if (cur.period) return cur.period
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  return undefined
}

/** 自身及所有后代 id（用于禁止把节点挂到自己子树下、级联删除） */
export function subtreeIds(rootId: string, todos: Todo[]): Set<string> {
  const kids = childrenIndex(todos)
  const out = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length) {
    for (const c of kids.get(stack.pop()!) ?? []) {
      if (!out.has(c.id)) { out.add(c.id); stack.push(c.id) }
    }
  }
  return out
}

function bigrams(s: string): Set<string> {
  const x = s.toLowerCase().replace(/\s+/g, '')
  const out = new Set<string>()
  for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2))
  if (x.length === 1) out.add(x)
  return out
}

/**
 * 会议待办 → 最相近的 KR（字符 bigram Jaccard，中英文通用）。
 * ponytail: 纯字面相似；接入本地 embedding 后替换。
 * 优先 project KR，其次 quarterly / strategic。
 */
export function suggestKr(title: string, todos: Todo[], minScore = 0.12): Todo | null {
  const a = bigrams(title)
  if (a.size === 0) return null
  const rank: Record<string, number> = { project: 0.02, quarterly: 0.01, strategic: 0 }
  let best: Todo | null = null
  let bestScore = minScore
  for (const t of todos) {
    if (t.kind !== 'kr' || !live(t) || t.status === 'done') continue
    const b = bigrams(t.title)
    let inter = 0
    for (const g of a) if (b.has(g)) inter++
    const score = inter / (a.size + b.size - inter) + (rank[t.scope ?? 'strategic'] ?? 0)
    if (score > bestScore) { best = t; bestScore = score }
  }
  return best
}
