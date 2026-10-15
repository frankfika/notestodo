import { useUI, type TaskMode } from '../state/ui'

const MODES: { id: TaskMode; label: string }[] = [
  { id: 'focus', label: '今日焦点' },
  { id: 'board', label: '看板' },
  { id: 'quarter', label: '本季 OKR' },
  { id: 'strategy', label: '战略' },
]

/** 任务页顶部视角切换：看板 / OKR 各视图共用一个入口，侧栏只留「任务」 */
export default function TaskModeSwitch(): JSX.Element {
  const view = useUI((s) => s.view)
  const taskMode = useUI((s) => s.taskMode)
  const goTaskMode = useUI((s) => s.goTaskMode)
  const goReport = useUI((s) => s.goReport)
  const current: TaskMode = view === 'board' ? 'board' : taskMode
  return (
    <div className="flex items-center gap-2">
      <div role="tablist" className="flex p-0.5 rounded-lg bg-bg-overlay border border-line">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={current === m.id}
            onClick={() => goTaskMode(m.id)}
            className={`px-3 h-7 text-xs rounded-md transition-colors ${
              current === m.id ? 'bg-bg-raise text-text-1 shadow-sm font-medium' : 'text-text-3 hover:text-text-1'
            }`}
          >{m.label}</button>
        ))}
      </div>
      <button onClick={goReport} className="btn-ghost text-xs h-7 px-2" title="本周周报草稿">周报 →</button>
    </div>
  )
}
