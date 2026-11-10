import { type JSX, useEffect, useState } from 'react'
import OfflineBanner from './OfflineBanner'

const DISMISS_KEY = 'install_banner_dismissed'

/** iOS Safari（非已安装的 PWA）——唯一没有自动安装提示的平台 */
function isIosSafari(): boolean {
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua)
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
  const standalone = ('standalone' in navigator && (navigator as { standalone?: boolean }).standalone === true)
    || window.matchMedia('(display-mode: standalone)').matches
  return ios && safari && !standalone
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: string }>
}

/**
 * PWA 安装引导条：
 *  - iOS Safari：提示「分享 → 添加到主屏幕」（系统不给 API，只能教）
 *  - Chromium：接 beforeinstallprompt，一键安装
 * 可关闭 / 不再提示（localStorage）。
 */
export default function InstallBanner(): JSX.Element | null {
  const [mode, setMode] = useState<'ios' | 'prompt' | null>(null)
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [online, setOnline] = useState(navigator.onLine)

  useEffect(() => {
    const on = (): void => setOnline(true)
    const off = (): void => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY)) return
    if (isIosSafari()) { setMode('ios'); return }
    const onPrompt = (e: Event): void => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
      setMode('prompt')
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  // 离线时不显示安装引导（装 PWA 这件事此刻没意义）
  const install = async (): Promise<void> => {
    if (!deferred) return
    await deferred.prompt()
    setMode(null)
  }
  const dismissForever = (): void => {
    localStorage.setItem(DISMISS_KEY, '1')
    setMode(null)
  }

  return (
    <>
      <OfflineBanner />
      {mode && online && (
        <div className="fixed bottom-16 md:bottom-4 inset-x-3 md:inset-x-auto md:right-4 md:max-w-sm z-40 rounded-xl border border-line bg-bg-raise shadow-lg p-3 flex items-center gap-3">
          <span className="text-accent text-lg leading-none">⤓</span>
          <p className="flex-1 text-[12.5px] text-text-1 leading-snug">
            {mode === 'ios'
              ? '把 openNotion 装到主屏幕：点浏览器底部分享 →「添加到主屏幕」'
              : '把 openNotion 安装为应用：独立窗口、离线可用、开机自启'}
          </p>
          {mode === 'prompt' && (
            <button onClick={() => void install()} className="btn-primary text-xs h-7 px-3 shrink-0">安装</button>
          )}
          <button onClick={() => setMode(null)} className="btn-ghost text-xs h-7 px-2 shrink-0">知道了</button>
          <button onClick={dismissForever} className="text-[11px] text-text-3 hover:text-text-1 shrink-0">不再提示</button>
        </div>
      )}
    </>
  )
}
