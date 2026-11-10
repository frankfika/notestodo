import type { JSX, ReactNode } from 'react'

/**
 * 通用空状态：这是什么（title）+ 第一步做什么（hint）+ 行动按钮（action）。
 * 严禁用"冷冰冰的暂无数据"四个字了事（DESIGN §5.4）。
 */
export interface EmptyStateProps {
  icon?: string
  /** 这是什么 —— 一句话说清这个位置原本该放什么 */
  title: string
  /** 第一步做什么 —— 支持 ReactNode，可内嵌强调 */
  hint?: ReactNode
  /** 主行动按钮 */
  action?: ReactNode
  /** 次要行动（可选） */
  secondary?: ReactNode
  /** 紧凑排版：左对齐单行 —— 用于页面内嵌的引导条（不是整页空态） */
  compact?: boolean
}

export default function EmptyState({
  icon = '◌',
  title,
  hint,
  action,
  secondary,
  compact = false,
}: EmptyStateProps): JSX.Element {
  if (compact) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-line bg-bg-overlay/60 px-4 py-3">
        <span className="text-base text-text-3 leading-none" aria-hidden="true">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-1">{title}</div>
          {hint && <div className="text-xs text-text-3 leading-relaxed">{hint}</div>}
        </div>
        {action}
        {secondary}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-6 gap-1.5">
      <div
        className="h-9 w-9 rounded-[10px] border border-line bg-bg-overlay grid place-items-center text-base text-text-3 mb-1"
        aria-hidden="true"
      >
        {icon}
      </div>
      <div className="text-sm text-text-1 font-medium">{title}</div>
      {hint && <div className="text-xs text-text-3 max-w-[46ch] leading-relaxed">{hint}</div>}
      {(action || secondary) && (
        <div className="mt-2 flex items-center gap-2">
          {action}
          {secondary}
        </div>
      )}
    </div>
  )
}
