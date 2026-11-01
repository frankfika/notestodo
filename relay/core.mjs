/**
 * openNotion 同步核心 —— Cloudflare Worker 与本地内存版服务器共用同一份逻辑。
 * 纯 JS（无类型依赖），类型见 core.d.mts；协议定义见 web/src/sync/protocol.ts。
 */

/** 单次请求最多变更条数 */
export const MAX_CHANGES = 500
/** 单次请求体上限（字节） */
export const MAX_BODY_BYTES = 1_000_000

/**
 * 冲突决胜：updated_at 大者胜；相同则 device_id 字典序大者胜（保证两端一致）。
 */
function compare(aUpdated, aDevice, bUpdated, bDevice) {
  if (aUpdated !== bUpdated) return aUpdated > bUpdated ? 1 : -1
  if (aDevice === bDevice) return 0
  return aDevice > bDevice ? 1 : -1
}

export function createState() {
  return { seq: 0, log: [], latest: {} }
}

/**
 * 处理一次同步往返：先推（写入并决胜），再拉（返回比 cursor 新、且非本设备产生的变更）。
 * @param {object} state
 * @param {object} request  { device_id, cursor, changes[] }
 */
export function applySync(state, request) {
  const conflicts = []
  const changes = Array.isArray(request?.changes) ? request.changes : []
  const deviceId = typeof request?.device_id === 'string' ? request.device_id : ''
  const cursor = Number.isFinite(request?.cursor) ? request.cursor : 0

  for (const ch of changes) {
    if (!ch || typeof ch.entity !== 'string' || typeof ch.id !== 'string') continue
    const key = `${ch.entity}:${ch.id}`
    const prev = state.latest[key]
    const incomingUpdated = typeof ch.updated_at === 'string' ? ch.updated_at : ''
    const prevUpdated = prev ? prev.updated_at : ''

    if (!prev || compare(incomingUpdated, deviceId, prevUpdated, prev.origin_device) > 0) {
      // 新版本胜出；若顶掉了别的设备的版本，记一次并发冲突（两边都保留，用户自己合并）
      if (prev && prev.origin_device !== deviceId) {
        conflicts.push({
          entity: ch.entity,
          id: ch.id,
          reason: 'concurrent-update',
          server_updated_at: incomingUpdated,
          local_updated_at: prevUpdated,
        })
      }
      state.seq += 1
      const entry = {
        seq: state.seq,
        entity: ch.entity,
        id: ch.id,
        op: ch.op === 'delete' ? 'delete' : 'upsert',
        data: ch.data ?? null,
        updated_at: incomingUpdated,
        sync_version: Number.isFinite(ch.sync_version) ? ch.sync_version : 0,
        deleted_at: ch.deleted_at ?? null,
        origin_device: deviceId,
      }
      state.log.push(entry)
      state.latest[key] = entry
    } else if (prev.origin_device !== deviceId) {
      // 本机这次改动比服务端版本旧 → 被丢弃，同时告诉本机：你和另一台设备撞了
      conflicts.push({
        entity: ch.entity,
        id: ch.id,
        reason: 'concurrent-update',
        server_updated_at: prevUpdated,
        local_updated_at: incomingUpdated,
      })
    }
  }

  const pulled = state.log
    .filter((e) => e.seq > cursor && e.origin_device !== deviceId)
    .map((e) => ({
      entity: e.entity,
      id: e.id,
      op: e.op,
      data: e.data,
      updated_at: e.updated_at,
      sync_version: e.sync_version,
      deleted_at: e.deleted_at,
    }))

  return {
    cursor: state.seq,
    server_time: new Date().toISOString(),
    changes: pulled,
    conflicts,
  }
}
