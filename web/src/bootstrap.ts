import { db } from './db/db'
import { seedBuiltinTemplates } from './db/seed'
import { getSettings } from './db/settings'
import { applyTheme } from './state/ui'
import { bindRecorderEngine } from './audio/engine'
import { resumePendingJobs } from './pipeline/jobs'
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
  // 监听创建
  db.meetings.hook('creating', () => {
    void dismissIfPending()
  })
  db.todos.hook('creating', () => {
    void dismissIfPending()
  })
  db.notes.hook('creating', (_key, note) => {
    // 区分 seed 噪声（title='未命名笔记' 且 body_md=''）——seed 写的是 '未命名笔记'，
    // 但用户新建也是这个标题。最简：只忽略 body_md === '' 且 title 为空的"纯占位"事件。
    if (note.title && note.title.trim()) void dismissIfPending()
  })
  db.audioChunks.hook('creating', () => {
    void dismissIfPending()
  })
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
  const settings = await getSettings()
  const theme =
    settings.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : settings.theme
  applyTheme(theme)
  bindRecorderEngine()
  void resumePendingJobs().catch((e) => console.error('恢复任务失败', e))
}
