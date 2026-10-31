import { useState } from 'react'
import { useUI } from '../../state/ui'
import TodosTree from './TodosTree'
import TodosList from './TodosList'

/**
 * 任务页：纯嵌套任务树 + 时间分组列表（OKR 三层概念已从 UI 移除，
 * 数据层 kind/scope 字段保留兼容）。看板在独立路由 board。
 */
export default function TodosPage(): JSX.Element {
  const [tab, setTab] = useState<'tree' | 'list'>('tree')
  const goBoard = useUI((s) => s.goBoard)

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-line shrink-0">
        {([['tree', '树'], ['list', '按时间']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 h-8 rounded-[8px] text-sm transition-colors ${
              tab === k ? 'bg-bg-raise text-text-1 font-medium shadow-sm' : 'text-text-2 hover:bg-bg-overlay hover:text-text-1'
            }`}
          >{label}</button>
        ))}
        <button
          onClick={goBoard}
          className="px-3 h-8 rounded-[8px] text-sm text-text-2 hover:bg-bg-overlay hover:text-text-1 transition-colors"
        >看板 →</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {tab === 'tree' ? <TodosTree /> : <TodosList />}
      </div>
    </div>
  )
}
