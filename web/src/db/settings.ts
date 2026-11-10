import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { DEFAULT_SETTINGS, type AppSettings } from '../types'

export async function getSettings(): Promise<AppSettings> {
  const row = await db.kv.get('settings')
  const value = (row?.value ?? {}) as Partial<AppSettings>
  return { ...DEFAULT_SETTINGS, ...value }
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
  // get+put 必须在同一读写事务里：跨事务的读-改-写和并发写入互相覆盖
  //（bootstrap 的一次性迁移就曾因此吞掉启动窗口内的并发 settings 写入）
  await db.transaction('rw', db.kv, async () => {
    const row = await db.kv.get('settings')
    const value = (row?.value ?? {}) as Partial<AppSettings>
    await db.kv.put({ key: 'settings', value: { ...DEFAULT_SETTINGS, ...value, ...patch } })
  })
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

/** 组件里实时读设置（设置页保存后各处立即跟随） */
export function useSettings(): AppSettings | undefined {
  return useLiveQuery(getSettings, [])
}
