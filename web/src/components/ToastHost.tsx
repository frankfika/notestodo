import { type JSX, useEffect } from 'react'
import { useToast } from '../state/toast'

/** 全局提示条宿主：左下角浮出，支持「撤销」动作，N 秒自动收起。 */
export default function ToastHost(): JSX.Element | null {
  const { msg, action, key, close } = useToast()

  // Esc 关闭
  useEffect(() => {
    if (!msg) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [msg, close])

  if (!msg) return null

  return (
    <div
      key={key}
      role="status"
      aria-live="polite"
      className="fixed left-1/2 bottom-6 z-[100] -translate-x-1/2"
    >
      <div className="card shadow-lg flex items-center gap-3 px-4 py-2.5 text-sm">
        <span className="text-text-1 whitespace-nowrap">{msg}</span>
        {action && (
          <button
            onClick={() => { action.onClick(); close() }}
            className="text-accent font-medium hover:underline shrink-0"
          >{action.label}</button>
        )}
        <button
          onClick={close}
          aria-label="关闭提示"
          className="text-text-3 hover:text-text-1 shrink-0 leading-none"
        >✕</button>
      </div>
    </div>
  )
}
