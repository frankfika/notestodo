import type { ID, ISODate, ISODateTime, Todo, TodoStatus } from '../../types'

/** 挂在 Mind Elixir NodeObj.metadata 上（ME6 无 data 字段） */
export type MindmapNodeMeta = {
  todoId: ID
  status: TodoStatus
  due_date?: ISODate
  /** 完成日期（status=done 时有值） */
  completed_at?: ISODateTime | null
  /** 关联人（自由文本名字） */
  assignee?: string
  waiting_reason?: string
  meeting_id?: ID
  isLeaf: boolean
  /** 合成「已完成」折叠组；禁止写回 Dexie */
  synthetic?: 'done-group'
}

export type TodaySlot = {
  leafId: ID
  mapId: ID
  slottedAt: ISODateTime
}

export type TodayState = {
  /** 默认 5，读写时钳制到 [3, 7] */
  capacity: number
  slots: TodaySlot[]
}

export type AddSlotResult =
  | { ok: true; state: TodayState }
  | { ok: false; reason: 'not_eligible' | 'duplicate' | 'full'; state: TodayState }

/** 对齐 mind-elixir@6 bus.fire('operation', …) 的写回子集 */
export type MeOperation =
  | { name: 'finishEdit'; target: { id: string; topic: string; parent?: { id: string } | null }; origin: string }
  | { name: 'addChild'; target: { id: string; topic: string; parent?: { id: string } | null } }
  | { name: 'insertSibling'; position: 'before' | 'after'; target: { id: string; topic: string; parent?: { id: string } | null } }
  | { name: 'insertParent'; target: { id: string; topic: string; parent?: { id: string } | null } }
  | { name: 'removeNodes'; target: Array<{ id: string }> }
  | {
      name: 'moveNodesIn' | 'moveNodesBefore' | 'moveNodesAfter'
      target: Array<{ id: string }>
      destination: { id: string; parent?: { id: string } | null }
    }

export type TodoOp =
  | { op: 'add'; todo: Todo }
  | { op: 'update'; id: ID; patch: Partial<Todo> }
  | { op: 'softDeleteSubtree'; rootId: ID }

export type ConfirmTarget = {
  mapId: ID
  parentId: ID
  label: string
}
