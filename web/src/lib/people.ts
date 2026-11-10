import { db } from '../db/db'
import { now, uid } from './id'

/**
 * 人员目录（本地模拟）。
 *
 * 为什么单独存一份「人」：
 * - `Todo.assignee` 一直是个自由文本（快速录入 `@张三`、AI 派单都靠它），
 *   不动它就不会破坏已有的数据和链路；
 * - 但自由文本没有「层级」和「对外/内部」的概念。这里的目录给名字补上元信息，
 *   名字对不上就当普通自由文本用，向后兼容。
 *
 * 多个层级：部门（org）→ 小组（team）→ 人（person），parent_id 串起来。
 * 关联人可以挂在任意一层（挂小组 = 整个小组负责）。
 *
 * 内部（internal）= 只在本机可见，不出现在「对外」的名单里。
 * 管理人默认内部 —— 你自己知道谁在管，不需要对外暴露。
 */

export type PersonLevel = 'org' | 'team' | 'person'
export type PersonRole = 'manager' | 'member'

export interface Person {
  id: string
  name: string
  level: PersonLevel
  /** 上级 id；null = 顶层。org → team → person */
  parent_id: string | null
  /** 内部角色：默认不出现在对外名单里 */
  internal: boolean
  role: PersonRole
  created_at: string
  updated_at: string
}

export const PEOPLE_KEY = 'mindmap_people'

export const LEVEL_LABEL: Record<PersonLevel, string> = {
  org: '部门',
  team: '小组',
  person: '个人',
}

/** 层级顺序：部门 → 小组 → 个人（展示时按这个序分组） */
export const LEVEL_ORDER: PersonLevel[] = ['org', 'team', 'person']

function mk(
  id: string,
  name: string,
  level: PersonLevel,
  parent_id: string | null,
  role: PersonRole = 'member',
  internal = false,
): Person {
  const ts = now()
  return { id, name, level, parent_id, internal, role, created_at: ts, updated_at: ts }
}

/**
 * 首次进入时铺一份模拟人员（用户可随时增删改）。
 * 两个部门、两个小组、四个自然人；两个管理人默认内部。
 */
export const SEED_PEOPLE: Person[] = [
  mk('p-org-product', '产品中心', 'org', null),
  mk('p-team-product', '产品组', 'team', 'p-org-product'),
  mk('p-zhangwei', '张伟', 'person', 'p-team-product', 'manager', true),
  mk('p-lina', '李娜', 'person', 'p-team-product'),
  mk('p-org-dev', '研发中心', 'org', null),
  mk('p-team-dev', '研发组', 'team', 'p-org-dev'),
  mk('p-wangqiang', '王强', 'person', 'p-team-dev', 'manager', true),
  mk('p-zhaomin', '赵敏', 'person', 'p-team-dev'),
]

/** 读人员目录；还没有就铺一份种子数据 */
export async function readPeople(): Promise<Person[]> {
  const row = await db.kv.get(PEOPLE_KEY)
  const list = row?.value
  if (Array.isArray(list) && list.length > 0) return list as Person[]
  await writePeople(SEED_PEOPLE)
  return SEED_PEOPLE
}

export async function writePeople(list: Person[]): Promise<void> {
  await db.kv.put({ key: PEOPLE_KEY, value: list })
}

/** 新增 / 更新一个人 */
export async function upsertPerson(
  input: Partial<Person> & { name: string },
): Promise<Person> {
  const list = await readPeople()
  const ts = now()
  const existing = input.id ? list.find((p) => p.id === input.id) : undefined
  const person: Person = {
    id: existing?.id ?? input.id ?? uid(),
    name: input.name.trim(),
    level: input.level ?? existing?.level ?? 'person',
    parent_id: input.parent_id ?? existing?.parent_id ?? null,
    internal: input.internal ?? existing?.internal ?? false,
    role: input.role ?? existing?.role ?? 'member',
    created_at: existing?.created_at ?? ts,
    updated_at: ts,
  }
  // 管理人默认不对外：新建管理人时若没显式给 internal，就当内部
  if (input.role === 'manager' && input.internal === undefined) person.internal = true
  const next = existing ? list.map((p) => (p.id === person.id ? person : p)) : [...list, person]
  await writePeople(next)
  return person
}

/** 删一个人，并把挂在他下面的人提到上一层（不留孤儿） */
export async function removePerson(id: string): Promise<void> {
  const list = await readPeople()
  const target = list.find((p) => p.id === id)
  if (!target) return
  const next = list
    .filter((p) => p.id !== id)
    .map((p) => (p.parent_id === id ? { ...p, parent_id: target.parent_id } : p))
  await writePeople(next)
}

/**
 * 对外的名单：不含内部人员。
 * includeInternal = true 时连内部管理人员一起列出来（自己看用）。
 */
export function visiblePeople(list: Person[], includeInternal: boolean): Person[] {
  return list.filter((p) => includeInternal || !p.internal)
}

/** 按名字找人（大小写不敏感）；找不到就是自由文本，不算目录里的人 */
export function resolvePerson(name: string | undefined, list: Person[]): Person | null {
  if (!name) return null
  const key = name.trim().toLowerCase()
  if (!key) return null
  return list.find((p) => p.name.trim().toLowerCase() === key) ?? null
}

/** 上溯路径：部门 › 小组 › 人 —— 用来把层级「串起来」 */
export function personPath(p: Person, byId: Map<string, Person>): string[] {
  const chain: string[] = []
  let cur: Person | undefined = p
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift(cur.name)
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  return chain
}
