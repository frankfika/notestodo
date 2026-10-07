import { db } from './db/db'
import { seedBuiltinTemplates } from './db/seed'
import { getSettings } from './db/settings'
import { applyTheme } from './state/ui'
import { bindRecorderEngine } from './audio/engine'
import { resumePendingJobs } from './pipeline/jobs'

/** 应用启动：迁移数据库 → 种子数据 → 主题 → 录音引擎 → 恢复中断的任务 */
export async function bootstrap(): Promise<void> {
  await db.open()
  await seedBuiltinTemplates()
  const settings = await getSettings()
  const theme =
    settings.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : settings.theme
  applyTheme(theme)
  bindRecorderEngine()
  // 上次会话遗留的录音/任务恢复
  void resumePendingJobs().catch((e) => console.error('恢复任务失败', e))
}
