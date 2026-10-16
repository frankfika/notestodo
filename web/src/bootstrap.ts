import { db } from './db/db'
import { seedBuiltinTemplates } from './db/seed'
import { getSettings, saveSettings } from './db/settings'
import { applyTheme } from './state/ui'
import { bindRecorderEngine } from './audio/engine'
import { resumePendingJobs } from './pipeline/jobs'
import { refreshBuiltinModels } from './lib/builtinModels'
import { ensurePersistentStorage } from './lib/storage'

/**
 * 第一次"用户动作"自动收掉 onboarding：
 * - 创建 Note / Todo / Meeting 行（不只是 seed 阶段）
 * - 启动录音
 * 不能与 seed 误触——我们用 'synced' 自动判断 source ≠ 'manual' 之类不可。
 * 简化策略：监听音频块首次写入，或 notes/todos/meetings 中任一 add 且内容非 '未命名' 即可。
 * 实现：监听 audioChunks.add + 任意 meetings.add + 任意 todos.add（限新插入）。
 */
function bindOnboardingAutoDismiss(): void {
  const ONBOARDING_KEY = 'onboarding_done_v1'
  const dismissIfPending = async (): Promise<void> => {
    const row = await db.kv.get(ONBOARDING_KEY)
    if (row?.value === true) return
    await db.kv.put({ key: ONBOARDING_KEY, value: true })
  }
  // 监听创建。
  // 注意：Dexie 的 creating hook 在调用方写事务的 zone 内执行；若直接调用
  // dismissIfPending()，其 kv 读写会被绑进该事务 —— 而单表自动事务
  // （如录音分片的 audioChunks put）不含 kv，会抛 NotFoundError。
  // setTimeout(…, 0) 让收引导动作逃出 Dexie zone，以独立事务安全执行。
  const dismissSoon = (): void => {
    setTimeout(() => void dismissIfPending().catch(() => undefined), 0)
  }
  db.meetings.hook('creating', dismissSoon)
  db.todos.hook('creating', dismissSoon)
  db.notes.hook('creating', (_key, note) => {
    // 区分 seed 噪声（title='未命名笔记' 且 body_md=''）——seed 写的是 '未命名笔记'，
    // 但用户新建也是这个标题。最简：只忽略 body_md === '' 且 title 为空的"纯占位"事件。
    if (note.title && note.title.trim()) dismissSoon()
  })
  db.audioChunks.hook('creating', dismissSoon)
}

/** 应用启动：迁移数据库 → 种子数据 → 主题 → 录音引擎 → 恢复中断的任务 */
export async function bootstrap(): Promise<void> {
  // 尽早申请持久化存储：Safari ITP 7 天驱逐 / 磁盘压力驱逐会吃掉录音（数据不可再生）
  void ensurePersistentStorage().then((s) => {
    if (!s.persisted && s.supported) {
      console.warn('存储持久化未获批 — 浏览器可能在磁盘压力下清理本地数据')
    }
  })
  await db.open()
  await seedBuiltinTemplates()
  bindOnboardingAutoDismiss()
  // 一次性迁移：旧版默认 dark 被整包写进 settings，升级后统一回到浅色默认（用户可再切回）
  if ((await db.kv.get('theme_light_default_v1'))?.value !== true) {
    await saveSettings({ theme: 'light' })
    await db.kv.put({ key: 'theme_light_default_v1', value: true })
  }
  const settings = await getSettings()
  // 直接传 'system' 给 store，OS 切换深浅时才能实时跟随
  applyTheme(settings.theme)
  bindRecorderEngine()
  void resumePendingJobs().catch((e) => console.error('恢复任务失败', e))
  void refreshBuiltinModels()
}
