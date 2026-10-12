import type { ReactNode } from 'react'

/**
 * 通用空状态：图标 + 标题 + 引导 + 可选操作。
 * 严禁用"冷冰冰的暂无数据"四个字了事（DESIGN §5.4）。
 */
export interface EmptyStateProps {
  icon?: string
  title: string
  hint?: string
  action?: ReactNode
}

export default function EmptyState({ icon = '◌', title, hint, action }: EmptyStateProps): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 px-6 gap-1.5">
      <div className="text-xl text-text-disabled leading-none mb-1" aria-hidden="true">
        {icon}
      </div>
      <div className="text-sm text-text-1 font-medium">{title}</div>
      {hint && <div className="text-xs text-text-3 max-w-[42ch] leading-relaxed">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}