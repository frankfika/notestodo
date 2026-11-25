import { type JSX, useEffect, useState } from 'react'
import { useUI } from '../state/ui'
import AiChat from './AiChat'

/**
 * 全局 AI 助手：右下角悬浮窗 + 悬浮唤起按钮。
 * - 唤起：右下角 ✦ 按钮（任何页面都在）、⌘J、侧栏 / 页面抽屉「快速提问」
 * - 形态：右下悬浮卡片，只占屏幕一角，主页面照常可见可操作，不整屏遮挡
 *   （手机端吸在底栏上方、顶部留出一截当前页面作上下文）
 */
export default function AiPanel(): JSX.Element {
  const open = useUI((s) => s.aiOpen)
  const setAiOpen = useUI((s) => s.setAiOpen)
  const [key, setKey] = useState(0)

  // 切换页面时自动收起——浮窗留着旧页的对话上下文，容易误会是对着新页在问
  useEffect(() => useUI.subscribe((s, prev) => {
    if (s.view !== prev.view && useUI.getState().aiOpen) setAiOpen(false)
  }), [setAiOpen])

  return (
    <>
      {/* 悬浮唤起按钮：手机端抬高避开底栏 */}
      {!open && (
        <button
          type="button"
          aria-label="打开 AI 助手"
          title="AI 助手（⌘J）"
          onClick={() => setAiOpen(true)}
          className="fixed z-40 right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:right-6 md:bottom-6 h-11 w-11 rounded-full bg-accent text-accent-contrast text-lg shadow-lg shadow-accent/25 flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
        >✦</button>
      )}
      {open && (
        <aside
          aria-label="AI 助手"
          className="drawer-enter fixed z-40 flex flex-col overflow-hidden rounded-2xl border border-line bg-bg-raise shadow-2xl
            inset-x-3 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] h-[min(540px,calc(100dvh-9rem))]
            sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[400px] sm:h-[min(620px,calc(100dvh-3rem))]"
        >
          <div className="flex items-center gap-2 px-4 h-12 border-b border-line shrink-0">
            <span className="text-accent">✦</span>
            <span className="text-sm font-medium text-text-1">AI 助手</span>
            <span className="text-[11px] text-text-3 hidden sm:inline">能问，也能动手</span>
            <button onClick={() => setKey((k) => k + 1)} className="btn-ghost text-[11px] h-6 px-2 ml-auto">新对话</button>
            <button onClick={() => setAiOpen(false)} className="icon-btn" title="关闭" aria-label="关闭">✕</button>
          </div>
          <AiChat key={key} variant="drawer" autoFocus />
        </aside>
      )}
    </>
  )
}
