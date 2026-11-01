import type { Table } from 'dexie'
import { db } from '../db/db'
import { getSettings, saveSettings } from '../db/settings'
import { uid } from '../lib/id'
import { CONFLICT_SUFFIX, SYNC_ENTITIES, type SyncChange, type SyncEntity, type SyncRequest, type SyncResponse } from './protocol'
import { installSyncHooks, withRemoteApply } from './outbox'

/**
 * 同步引擎：一次往返 = 推本地变更 + 拉服务端变更。
 *
 * 冲突策略（服务端决胜 + 客户端留副本）：服务端按 (updated_at, device_id) 保留一份，
 * 并把并发冲突记进 conflicts；客户端收到冲突后**保留本地版本**，另存一份
 * 「（冲突副本）」，由用户自己合并 —— 永不丢数据。
 * ponytail: 没有分布式锁/版本向量/CRDT；要更强的一致性时再引入。
 */

let syncing: Promise<SyncResult> | null = null

export interface SyncResult {
  ok: boolean
  error?: string
  pushed: number
  pulled: number
  conflicts: number
}

function tableFor(entity: SyncEntity): { get: (id: string) => Promise<any>; put: (row: any) => Promise<any>; update: (id: string, patch: any) => Promise<any> } | null {
  const tables = db as unknown as Record<string, any>
  return tables[entity] ?? null
}

async function ensureDeviceId(): Promise<string> {
  const settings = await getSettings()
  if (settings.sync_device_id) return settings.sync_device_id
  const id = uid()
  await saveSettings({ sync_device_id: id })
  return id
}

export async function pendingCount(): Promise<number> {
  return db.syncOutbox.count()
}

/** 手动/自动同步入口（并发调用会复用同一个请求） */
export function syncNow(): Promise<SyncResult> {
  if (syncing) return syncing
  syncing = runSync().finally(() => { syncing = null })
  return syncing
}

async function runSync(): Promise<SyncResult> {
  installSyncHooks()
  const settings = await getSettings()
  const base = settings.sync_server_url.trim().replace(/\/+$/, '')
  if (!settings.sync_enabled || !base || !settings.sync_token) {
    return { ok: false, error: '未配置同步', pushed: 0, pulled: 0, conflicts: 0 }
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await saveSettings({ sync_last_error: '当前离线，未同步' })
    return { ok: false, error: '当前离线', pushed: 0, pulled: 0, conflicts: 0 }
  }

  const deviceId = await ensureDeviceId()
  const rows = await db.syncOutbox.toArray()
  const changes: SyncChange[] = rows.map((r) => ({
    entity: r.entity as SyncEntity,
    id: r.entity_id,
    op: r.op,
    data: r.op === 'delete' ? null : r.data,
    updated_at: r.updated_at,
    sync_version: r.sync_version,
    deleted_at: (r.data?.deleted_at as string | null) ?? null,
  }))

  const payload: SyncRequest = { device_id: deviceId, cursor: settings.sync_cursor, changes }
  let res: SyncResponse
  try {
    const r = await fetch(`${base}/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.sync_token}` },
      body: JSON.stringify(payload),
    })
    if (!r.ok) throw new Error(`同步失败：HTTP ${r.status}`)
    res = (await r.json()) as SyncResponse
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await saveSettings({ sync_last_error: msg })
    return { ok: false, error: msg, pushed: 0, pulled: 0, conflicts: 0 }
  }

  // 已推送的出队：只删「推的时候那一版」——同步期间又被改过的行要留在队列里
  const pushedAt = new Map(rows.map((r) => [r.id!, r.updated_at]))
  if (pushedAt.size) {
    await db.syncOutbox
      .where('id')
      .anyOf([...pushedAt.keys()])
      .filter((r) => pushedAt.get(r.id!) === r.updated_at)
      .delete()
  }

  let pulled = 0
  /** 拉取时会被服务端版本覆盖的本地版本 —— 循环结束后在事务外留副本（副本要走 hook 同步给其它设备） */
  const displaced: { entity: SyncEntity; local: Record<string, unknown> & { title?: string } }[] = []
  await withRemoteApply(async () => {
    // 整段拉取包在一个事务里：hook 在事务内同步触发，applyingRemote 标志此刻不可能
    // 误伤用户写入 —— 同一连接上的本地写会排队等本事务提交，hook 触发时标志已复位。
    // （曾经的实现逐条 await，await 间隙的用户编辑被抑制标志吞掉、永远进不了发件箱。）
    await db.transaction('rw', SYNC_ENTITIES.map((e) => (db as unknown as Record<string, Table<unknown, string>>)[e]), async () => {
      for (const ch of res.changes ?? []) {
        const table = tableFor(ch.entity)
        if (!table) continue
        const local = await table.get(ch.id)
        // 决胜规则与服务端 compare() 严格一致：updated_at 大者胜；平局 device_id 大者胜。
        // 两端规则不一致时，输的那端会跳过变更且 cursor 已推进 —— 永久分叉。
        if (local && !remoteWins(local.updated_at, ch.updated_at, ch.origin_device ?? '', deviceId)) continue
        const merged = ch.op === 'delete'
          ? { ...local, deleted_at: ch.deleted_at ?? new Date().toISOString(), updated_at: ch.updated_at, sync_version: ch.sync_version }
          : { ...(local ?? {}), ...ch.data, id: ch.id }
        // 本地这版会被覆盖且内容确实不同 → 先记下，循环后存「冲突副本」（永不丢数据）
        if (local && typeof local.title === 'string' && JSON.stringify(local) !== JSON.stringify(merged)) {
          displaced.push({ entity: ch.entity, local })
        }
        await table.put(merged)
        pulled++
      }
    })
  })

  // 冲突副本：只有「本地这版输了」才值得留 —— 赢家那份等于本地现有版本，再存一份是纯噪音。
  // 副本不抑制 hook：它要同步给其它设备，每台都能自行合并。
  // 同一实体可能在「推送落败」和「拉取被覆盖」两条路径各命中一次，只留一份。
  let conflicts = 0
  const copied = new Set<string>()
  for (const d of displaced) {
    if (await makeConflictCopy(d.entity, d.local)) { conflicts++; copied.add(`${d.entity}:${d.local.id}`) }
  }
  for (const c of res.conflicts ?? []) {
    const table = tableFor(c.entity)
    if (!table) continue
    if (copied.has(`${c.entity}:${c.id}`)) continue
    const local = await table.get(c.id)
    if (!local) continue
    if (local.updated_at >= c.server_updated_at) continue // 本地是赢家，无副本可留
    if (await makeConflictCopy(c.entity, local)) conflicts++
  }

  await saveSettings({
    sync_cursor: res.cursor ?? settings.sync_cursor,
    sync_last_at: new Date().toISOString(),
    // 同步本身成功，但有变更因设备时钟异常被丢弃 —— 提示校时钟，不静默
    sync_last_error: res.rejected?.length ? `已跳过 ${res.rejected.length} 条时钟异常的变更（未同步，请校正设备时间）` : null,
  })

  return { ok: true, pushed: changes.length, pulled, conflicts }
}

/** 与服务端 compare() 同一决胜规则：远端赢 iff 更新，或同刻且远端 device_id 更大 */
function remoteWins(localUpdated: string, remoteUpdated: string, remoteDevice: string, localDevice: string): boolean {
  if (localUpdated !== remoteUpdated) return localUpdated < remoteUpdated
  return remoteDevice > localDevice
}

/** 把一版将被覆盖的本地实体另存为「（冲突副本）」；返回是否真存了 */
async function makeConflictCopy(entity: SyncEntity, local: Record<string, unknown> & { title?: string }): Promise<boolean> {
  if (typeof local.title !== 'string') return false
  const table = tableFor(entity)
  if (!table) return false
  const now = new Date().toISOString()
  await table.put({
    ...local,
    id: uid(),
    title: `${local.title}${CONFLICT_SUFFIX}`,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  })
  return true
}
