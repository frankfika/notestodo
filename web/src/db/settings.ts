import { db } from './db'
import { DEFAULT_SETTINGS, type AppSettings } from '../types'

export async function getSettings(): Promise<AppSettings> {
  const row = await db.kv.get('settings')
  const value = (row?.value ?? {}) as Partial<AppSettings>
  return { ...DEFAULT_SETTINGS, ...value }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
  const current = await getSettings()
  const next = { ...current, ...patch }
  await db.kv.put({ key: 'settings', value: next })
}

/** 内存缓存，避免每次读取都走 IndexedDB */
let cache: AppSettings | null = null

export async function getCachedSettings(): Promise<AppSettings> {
  if (cache) return cache
  cache = await getSettings()
  return cache
}

export function invalidateSettingsCache(): void {
  cache = null
}
