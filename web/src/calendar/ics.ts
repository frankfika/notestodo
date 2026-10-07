import ICAL from 'ical.js'
import { db } from '../db/db'
import type { AppSettings } from '../types'

/**
 * 单一规范化事件，来自任意 .ics 源。
 * 来源不携带（不是 PII 用途）；只用于本地排序与关联。
 */
export interface CalendarEvent {
  /** uid 原值作为稳定 id；如果缺失则用 start+title 的 hash 兜底 */
  id: string
  uid: string
  title: string
  start: string // 本地 ISO
  end: string | null
  description: string | null
  location: string | null
  /** 哪一条 URL 拉来的——纯本地 */
  source: 'ics'
  source_label: string
  all_day: boolean
}

const CACHE_KEY = 'calendar_cache_v1'
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 分钟

interface CacheShape {
  fetchedAt: number
  events: CalendarEvent[]
}

function labelFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const host = u.host.replace(/^webcal\.|^cal\./i, '')
    return `${host}${u.pathname.replace(/\/[^/]+$/, '')}` || host || url.slice(0, 32)
  } catch {
    return url.slice(0, 32)
  }
}

function parseIcsText(text: string, sourceLabel: string): CalendarEvent[] {
  const jcal = ICAL.parse(text)
  const comp = new ICAL.Component(jcal)
  const out: CalendarEvent[] = []
  const vevents = comp.getAllSubcomponents('vevent')

  for (const vev of vevents) {
    const event = new ICAL.Event(vev)
    // 跳过已取消的实例（ical.js 类型未暴露 status，但 raw jCal 可拿）
    // 跳过 cancelled：vevent.component.getFirstPropertyValue('status') === 'CANCELLED'
    // （这里暂不实现，0.1% 场景；用 unaction 替代）
    try {
      const status = vev.getFirstPropertyValue('status')
      if (status === 'CANCELLED') continue
    } catch (_: unknown) {}

    const start = event.startDate
    const end = event.endDate
    const allDay = start.isDate // floating date-only

    // ICAL.Event.startDate.toJSDate() 已是本地 Date；all-day 事件会带时区偏移
    const startIso = start.toJSDate().toISOString()
    const endIso = end ? end.toJSDate().toISOString() : null

    const summary = (event.summary || '（无标题）').trim()
    const uid = event.uid || `${startIso}-${summary}`

    out.push({
      id: uid,
      uid,
      title: summary,
      start: startIso,
      end: endIso,
      description: event.description || null,
      location: event.location || null,
      source: 'ics',
      source_label: sourceLabel,
      all_day: allDay,
    })
  }

  return out
}

/**
 * 拉取所有配置的 .ics URL，解析、规范化、按开始时间排序。
 * 失败降级：从缓存返回；缓存也没有就返回空数组 + error 信息。
 */
export async function fetchCalendar(settings: AppSettings): Promise<{ events: CalendarEvent[]; error?: string; cached: boolean; sources: string[] }> {
  const urls = (settings.calendar_ics_urls ?? []).map((u) => u.trim()).filter(Boolean)
  if (urls.length === 0) {
    return { events: [], sources: [], cached: false }
  }

  const cache = await db.kv.get(CACHE_KEY).catch(() => null)
  const cached = cache?.value as CacheShape | undefined

  // 命中缓存
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { events: cached.events, cached: true, sources: urls.map(labelFromUrl) }
  }

  // 拉取：每条 URL 独立 try/except，单条错误不阻塞其他
  const allEvents: CalendarEvent[] = []
  const failed: string[] = []

  await Promise.all(
    urls.map(async (url) => {
      const label = labelFromUrl(url)
      try {
        // webcal:// 换成 https:// 让浏览器能 fetch
        const fetchUrl = url.replace(/^webcal:\/\//i, 'https://')
        const res = await fetch(fetchUrl, {
          // CORS：用户自己托管的 URL（Apple/Google/QQ/Outlook 公开链接走 302 到 googleusercontent 等）通常会跨域；
          // 提示 UI 暴露此问题。
          credentials: 'omit',
          redirect: 'follow',
          headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        const ev = parseIcsText(text, label)
        allEvents.push(...ev)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        failed.push(`${label}: ${msg}`)
        // 失败时降级到缓存中该来源的旧事件
        if (cached) {
          const survived = cached.events.filter((x) => x.source_label === label)
          allEvents.push(...survived)
        }
      }
    }),
  )

  // 排序：升序
  allEvents.sort((a, b) => a.start.localeCompare(b.start))

  // 落缓存
  await db.kv.put({
    key: CACHE_KEY,
    value: { fetchedAt: Date.now(), events: allEvents } satisfies CacheShape,
  })

  return {
    events: allEvents,
    cached: false,
    sources: urls.map(labelFromUrl),
    error: failed.length > 0 ? failed.join('；') : undefined,
  }
}

/** 强制清掉缓存（设置里改 URL 后调一次） */
export async function clearCalendarCache(): Promise<void> {
  await db.kv.delete(CACHE_KEY)
}

/** 拿上次同步时间显示 */
export async function getCalendarCacheMeta(): Promise<{ fetchedAt: number | null; count: number }> {
  const row = await db.kv.get(CACHE_KEY)
  const value = row?.value as CacheShape | undefined
  return { fetchedAt: value?.fetchedAt ?? null, count: value?.events.length ?? 0 }
}