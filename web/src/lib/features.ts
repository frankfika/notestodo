import { db } from '../db/db'

export type FeatureFlags = {
  mindmap_tasks: boolean
}

const DEFAULT: FeatureFlags = { mindmap_tasks: false }

/** 读 kv features；缺省返回 DEFAULT。 */
export async function getFeatures(): Promise<FeatureFlags> {
  const row = await db.kv.get('features')
  const v = (row?.value ?? {}) as Partial<FeatureFlags>
  return { ...DEFAULT, ...v }
}

/** 写单个 flag；整对象读改写。 */
export async function setFeature<K extends keyof FeatureFlags>(
  key: K,
  value: FeatureFlags[K],
): Promise<void> {
  const cur = await getFeatures()
  await db.kv.put({ key: 'features', value: { ...cur, [key]: value } })
}

export async function isMindmapTasksEnabled(): Promise<boolean> {
  return (await getFeatures()).mindmap_tasks
}
