import { useEffect, useState } from 'react'

/**
 * 离线提示条：只在断网时出现，一行字说清"本地照常、云端暂停"。
 * ponytail: navigator.onLine + 事件就够，不做网络状态管理。
 */
export default function OfflineBanner(): JSX.Element | null {
  const [offline, setOffline] = useState(!navigator.onLine)

  useEffect(() => {
    const on = (): void => setOffline(false)
    const off = (): void => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  if (!offline) return null

  return (
    <div className="px-4 py-1.5 bg-warning/10 border-b border-warning/25 text-[12px] text-text-2 flex items-center gap-2">
      <span className="text-warning">⛌</span>
      <span>离线模式 · 本地功能照常（录音 / 本机转录 / 笔记 / 任务 / 看板），云端 AI 与日历订阅需要联网</span>
    </div>
  )
}
