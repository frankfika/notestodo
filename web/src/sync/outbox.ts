import type { Table } from 'dexie'
import { db, type SyncOutboxRow } from '../db/db'
import { saveSettings } from '../db/settings'
import { SYNC_ENTITIES, type SyncEntity } from './protocol'

/**
 * 本地变更捕获：Dexie hooks → 发件箱。
 *
 * 应用远端变更时用 `withRemoteApply` 抑制 hook，避免回环（远端写 → 又进发件箱 → 又推回去）。
 * ponytail: 每个实体只保留最新一条待推送状态（同一实体多次改动合并成一次推送）。
 */

let applyingRemote = false

export async function withRemoteApply<T>(fn: () => Promise<T>): Promise<T> {
  applyingRemote = true
  try {
    return await fn()
  } finally {
    applyingRemote = false
  }
}

const json = (v: unknown): Record<string, unknown> | null =>
  v == null ? null : JSON.parse(JSON.stringify(v))

/** 某个实体的最新待推送状态 */
async function enqueue(entity: SyncEntity, entityId: string, op: 'upsert' | 'delete', data: unknown): Promise<void> {
  const snapshot = json(data) as (Record<string, unknown> & { updated_at: string; sync_version: number; deleted_at?: string | null }) | null
  const row: SyncOutboxRow = {
    entity,
    entity_id: entityId,
    op,
    data: snapshot,
    updated_at: snapshot?.updated_at ?? new Date().toISOString(),
    sync_version: snapshot?.sync_version ?? 0,
    created_at: new Date().toISOString(),
  }
  const existing = await db.syncOutbox.where('[entity+entity_id]').equals([entity, entityId]).first()
  if (existing?.id != null) await db.syncOutbox.update(existing.id, row)
  else await db.syncOutbox.add(row)
}

interface Syncable {
  id: string
  updated_at: string
  sync_version: number
  deleted_at: string | null
  title?: string
}

function watch<T extends Syncable>(entity: SyncEntity, table: Table<T, string>): void {
  // hook 本身必须同步返回（Dexie 不 await 它）；同步拍快照，下一 tick 再写发件箱
  // —— 否则会在 hook 所属事务里访问未声明的表，Dexie 直接报错（错误被吞 → 变更丢失）。
  const queue = (id: string, op: 'upsert' | 'delete', data: unknown): void => {
    if (applyingRemote) return
    const snapshot = data
    // 失败重试 3 次（间隔 1s）后仍败 → 写进同步错误，不能静默：
    // 发件箱丢一条 = 这条变更永远推不出去且毫无迹象
    const attempt = (n: number): void => {
      setTimeout(() => {
        void enqueue(entity, id, op, snapshot).catch(() => {
          if (n < 3) attempt(n + 1)
          else void saveSettings({ sync_last_error: '发件箱写入失败：最近的本地变更可能不会被同步' }).catch(() => {})
        })
      }, n === 0 ? 0 : 1000)
    }
    attempt(0)
  }
  table.hook('creating', (_pk, obj: T) => {
    queue(obj.id, obj.deleted_at ? 'delete' : 'upsert', obj)
  })
  // 签名是 (modifications, primKey, oldValue, transaction) —— 第三个参数才是旧值
  table.hook('updating', (mods, _pk: string, old: T) => {
    const next = { ...old, ...mods }
    queue(next.id, next.deleted_at ? 'delete' : 'upsert', next)
  })
  // 硬删除：留一份墓碑推给服务端（软删走 updating 分支）
  table.hook('deleting', (_pk, obj: T) => {
    const ts = new Date().toISOString()
    queue(obj.id, 'delete', { ...obj, deleted_at: ts, updated_at: ts })
  })
}

let watched = false

/** 幂等：多次调用只注册一次 hook */
export function installSyncHooks(): void {
  if (watched) return
  watched = true
  const tables = db as unknown as Record<string, Table<never, string>>
  for (const entity of SYNC_ENTITIES) {
    const table = tables[entity] as unknown as Table<Syncable, string> | undefined
    if (table) watch(entity, table)
  }
}
