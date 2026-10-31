import type { AppSettings } from '../types'
import type { db } from '../db/db'
import { uid, now } from './id'

// ponytail: 未实测 —— 飞书 calendar API 字段按公开文档保守取值：
// 用 tenant_access_token + 主日历 primary 拉未来 7 天日程；start_time/end_time
// 是秒级 unix 字符串，时区字段忽略（本地展示够用）。若租户的 primary calendar
// 不可用，需换成先 GET /calendar/v4/calendars 拿 calendar_id 列表。

interface FeishuEvent {
  event_id: string
  summary?: string
  start_time?: { timestamp?: string }
  end_time?: { timestamp?: string }
}

async function tenantToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const j = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string }
  if (j.code !== 0 || !j.tenant_access_token) throw new Error(`飞书鉴权失败：${j.msg ?? res.status}`)
  return j.tenant_access_token
}

/** 飞书主日历未来 7 天日程 → 会议壳（无音频），按 calendar_event_id 幂等。 */
export async function importFeishuEvents(
  settings: AppSettings,
  dbi: typeof db,
): Promise<{ imported: number; skipped: number }> {
  const appId = settings.feishu_app_id.trim()
  const appSecret = settings.feishu_app_secret.trim()
  if (!appId || !appSecret) throw new Error('请先填写飞书 App ID / App Secret')
  const token = await tenantToken(appId, appSecret)

  const startSec = Math.floor(Date.now() / 1000)
  const endSec = startSec + 7 * 86400
  const url = `https://open.feishu.cn/open-apis/calendar/v4/calendars/primary/events?start_time=${startSec}&end_time=${endSec}&page_size=50`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const j = (await res.json()) as { code?: number; msg?: string; data?: { items?: FeishuEvent[] } }
  if (j.code !== 0) throw new Error(`飞书日历拉取失败：${j.msg ?? res.status}`)
  const events = j.data?.items ?? []

  const existing = new Set(
    (await dbi.meetings.toArray()).map((m) => m.calendar_event_id).filter(Boolean),
  )
  const ts = now()
  let imported = 0
  let skipped = 0
  for (const ev of events) {
    if (!ev.event_id || existing.has(ev.event_id)) { skipped++; continue }
    const startMs = ev.start_time?.timestamp ? Number(ev.start_time.timestamp) * 1000 : Date.now()
    const endMs = ev.end_time?.timestamp ? Number(ev.end_time.timestamp) * 1000 : undefined
    await dbi.meetings.add({
      id: uid(),
      title: ev.summary || '（无标题日程）',
      calendar_event_id: ev.event_id,
      source: 'feishu',
      status: 'transcribed', // 日程壳：无音频可转录
      started_at: new Date(startMs).toISOString(),
      ended_at: endMs ? new Date(endMs).toISOString() : undefined,
      audio: { format: '', codec: '', duration_ms: 0, chunk_count: 0, size_bytes: 0, gaps: [] },
      note_id: '',
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
    imported++
  }
  return { imported, skipped }
}
