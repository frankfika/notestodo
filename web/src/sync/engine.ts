import { db } from '../db/db'
import { getSettings, saveSettings } from '../db/settings'
import { uid } from '../lib/id'
import { CONFLICT_SUFFIX, type SyncChange, type SyncEntity, type SyncRequest, type SyncResponse } from './protocol'
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
  await withRemoteApply(async () => {
    for (const ch of res.changes ?? []) {
      const table = tableFor(ch.entity)
      if (!table) continue
      const local = await table.get(ch.id)
      // 本地版本更新（updated_at 更大）就以本地为准，不覆盖
      if (local && local.updated_at >= ch.updated_at) continue
      if (ch.op === 'delete') {
        await table.update(ch.id, {
          deleted_at: ch.deleted_at ?? new Date().toISOString(),
          updated_at: ch.updated_at,
          sync_version: ch.sync_version,
        })
      } else if (ch.data) {
        await table.put({ ...(local ?? {}), ...ch.data, id: ch.id })
      }
      pulled++
    }
  })

  // 冲突：保留本地版本 + 另存一份「冲突副本」
  let conflicts = 0
  for (const c of res.conflicts ?? []) {
    const marker = `sync_conflict_${c.entity}_${c.id}`
    if (await db.kv.get(marker)) continue
    const table = tableFor(c.entity)
    if (!table) continue
    const local = await table.get(c.id)
    if (!local) continue
    const hasTitle = typeof local.title === 'string'
    if (!hasTitle) continue
    const copy = {
      ...local,
      id: uid(),
      title: `${local.title}${CONFLICT_SUFFIX}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    }
    await table.put(copy) // 不抑制 hook：副本要继续同步给其它设备
    await db.kv.put({ key: marker, value: true })
    conflicts++
  }

  await saveSettings({
    sync_cursor: res.cursor ?? settings.sync_cursor,
    sync_last_at: new Date().toISOString(),
    sync_last_error: null,
  })

  return { ok: true, pushed: changes.length, pulled, conflicts }
}
