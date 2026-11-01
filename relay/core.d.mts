/**
 * core.mjs 的类型声明（给 worker.ts 用，避免安装 @cloudflare/workers-types）。
 */
export interface SyncChange {
  entity: string
  id: string
  op: 'upsert' | 'delete'
  data: Record<string, unknown> | null
  updated_at: string
  sync_version: number
  deleted_at: string | null
  /** 产生该变更的设备（平局决胜用，服务端 compare() 同规则） */
  origin_device?: string
}

export interface SyncRejected {
  entity: string
  id: string
  updated_at: string
}

export interface SyncConflict {
  entity: string
  id: string
  reason: 'concurrent-update'
  server_updated_at: string
  local_updated_at: string
}

export interface SyncRequest {
  device_id: string
  cursor: number
  changes: SyncChange[]
}

export interface SyncStateEntry extends SyncChange {
  seq: number
  origin_device: string
}

export interface SyncState {
  seq: number
  log: SyncStateEntry[]
  latest: Record<string, SyncStateEntry>
}

export interface SyncResult {
  cursor: number
  server_time: string
  changes: SyncChange[]
  conflicts: SyncConflict[]
  /** 时间戳非法或领先服务端过多的变更（已丢弃，客户端应提示用户校时钟） */
  rejected: SyncRejected[]
}

export declare const MAX_CHANGES: number
export declare const MAX_BODY_BYTES: number
export declare const MAX_SKEW_MS: number
export declare function createState(): SyncState
export declare function applySync(state: SyncState, request: SyncRequest): SyncResult
