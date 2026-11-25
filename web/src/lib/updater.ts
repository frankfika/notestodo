import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauri } from './tauri'
import { useToast } from '../state/toast'

export interface UpdateInfo {
  version: string
  notes?: string
  date?: string
}

function toInfo(update: Update): UpdateInfo {
  return {
    version: update.version,
    notes: update.body ?? undefined,
    date: update.date ?? undefined,
  }
}

/**
 * 检查 GitHub Releases 上有没有新版本。
 * 仅 Tauri 壳内可用；浏览器 / 测试环境静默返回 null。
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null
  try {
    const update = await check()
    return update ? toInfo(update) : null
  } catch (err) {
    // 网络不通 / latest.json 还没有发布过，都不算错误
    console.warn('[updater] check failed:', err)
    return null
  }
}

/** 发现新版本 → 下载 + 安装 + 重启。返回 false 表示用户取消或失败。 */
export async function downloadAndInstall(info?: UpdateInfo): Promise<boolean> {
  if (!isTauri()) return false
  const { show } = useToast.getState()
  try {
    const update = await check()
    if (!update) return false
    const same = info && update.version !== info.version
    show(`正在下载 v${update.version}…`, undefined, 4000)
    // 流式下载并上报进度
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        const mb = event.data.contentLength ? `（${Math.round(event.data.contentLength / 1024 / 1024)} MB）` : ''
        show(`正在下载 v${update.version}${mb}…`, undefined, 3000)
      } else if (event.event === 'Progress') {
        // 进度事件太密，不刷 toast；保留 Started/Finished 两个节点
      } else if (event.event === 'Finished') {
        show('下载完成，即将重启安装…', undefined, 3000)
      }
    })
    void same
    await relaunch()
    return true
  } catch (err) {
    console.error('[updater] install failed:', err)
    show('更新失败，稍后再试', undefined, 4000)
    return false
  }
}
