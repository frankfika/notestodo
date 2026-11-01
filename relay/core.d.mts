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
}

export declare const MAX_CHANGES: number
export declare const MAX_BODY_BYTES: number
export declare function createState(): SyncState
export declare function applySync(state: SyncState, request: SyncRequest): SyncResult
