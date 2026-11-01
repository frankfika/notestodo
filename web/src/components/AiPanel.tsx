import { useState } from 'react'
import { useUI } from '../state/ui'
import AiChat from './AiChat'

/**
 * 全局 AI 抽屉：任何页面 ⌘J / 侧栏「快速提问」唤起。
 * 与首页 AI 工作台共用同一套对话与动作执行逻辑（AiChat）。
 */
export default function AiPanel(): JSX.Element | null {
  const open = useUI((s) => s.aiOpen)
  const setAiOpen = useUI((s) => s.setAiOpen)
  const [key, setKey] = useState(0)

  if (!open) return null

  return (
    <aside
      aria-label="AI 助手"
      className="drawer-enter fixed inset-0 md:inset-auto md:right-0 md:top-0 md:bottom-0 z-40 w-full md:w-[400px] md:border-l border-line bg-bg-raise flex flex-col md:shadow-2xl"
    >
      <div className="flex items-center gap-2 px-4 h-12 border-b border-line shrink-0">
        <span className="text-accent">✦</span>
        <span className="text-sm font-medium text-text-1">AI 助手</span>
        <span className="text-[11px] text-text-3">能问，也能动手</span>
        <button onClick={() => setKey((k) => k + 1)} className="btn-ghost text-[11px] h-6 px-2 ml-auto">新对话</button>
        <button onClick={() => setAiOpen(false)} className="icon-btn" title="关闭" aria-label="关闭">✕</button>
      </div>
      <AiChat key={key} variant="drawer" autoFocus />
    </aside>
  )
}
