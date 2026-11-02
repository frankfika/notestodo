/**
 * openNotion 同步协议 v1 —— 客户端与 relay 必须严格对齐这份定义。
 *
 * 设计取向：单次往返 = 推 + 拉（POST /v1/sync），无长连接、无 WebSocket。
 * 冲突策略：**永不丢数据** —— 服务端按 (updated_at, device_id) 决胜保留一份，
 * 同时把并发冲突记进 conflicts 列表；客户端对冲突项保留本地版本 + 生成
 * 一份「冲突副本」，由用户自己合并。多端离线优先，不做分布式锁。
 */

export const SYNC_ENTITIES = [
  'notes',
  'todos',
  'notebooks',
  'tags',
  'tagBindings',
  'boards',
  'comments',
] as const

export type SyncEntity = (typeof SYNC_ENTITIES)[number]

export type SyncOp = 'upsert' | 'delete'

/** 一条变更（客户端 → 服务端 / 服务端 → 客户端 同形） */
export interface SyncChange {
  entity: SyncEntity
  id: string
  op: SyncOp
  /** 实体字段全量快照（delete 时为 null） */
  data: Record<string, unknown> | null
  updated_at: string
  sync_version: number
  deleted_at: string | null
  /** 仅服务端下发：产生该变更的设备 id（平局决胜用，规则与服务端 compare() 一致） */
  origin_device?: string
}

export interface SyncRequest {
  /** 本机设备 id（首次启用同步时生成并持久化） */
  device_id: string
  /** 已同步到的服务端序号；0 = 全量拉取 */
  cursor: number
  /** 待推送的本地变更（可能为空） */
  changes: SyncChange[]
}

export interface SyncConflict {
  entity: SyncEntity
  id: string
  /** 目前固定 concurrent-update */
  reason: 'concurrent-update'
  /** 服务端胜出版本的 updated_at */
  server_updated_at: string
  /** 本地胜出版本的 updated_at */
  local_updated_at: string
}

export interface SyncResponse {
  /** 拉取后客户端应保存的游标 */
  cursor: number
  server_time: string
  /** 服务端侧比 cursor 更新的变更（不含本设备自己产生的） */
  changes: SyncChange[]
  /** 并发冲突（客户端据此保留本地 + 生成副本） */
  conflicts: SyncConflict[]
  /** 时间戳异常被服务端丢弃的变更（较旧 relay 可能不返回该字段） */
  rejected?: SyncRejected[]
}

export interface SyncStatus {
  /** 是否已配置（服务器地址 + 令牌都有） */
  configured: boolean
  enabled: boolean
  /** 本地待推送变更数 */
  pending: number
  /** 最近一次成功同步时间 */
  last_sync_at: string | null
  /** 最近一次错误 */
  last_error: string | null
  cursor: number
}

/** 冲突副本标题后缀 */
export const CONFLICT_SUFFIX = '（冲突副本）'

/** 被服务端拒绝的变更（时间戳非法或设备时钟领先过多），客户端应提示用户校时钟 */
export interface SyncRejected {
  entity: SyncEntity
  id: string
  updated_at: string
}
