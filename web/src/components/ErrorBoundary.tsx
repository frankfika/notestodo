import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 顶层错误边界：渲染崩溃时给出可操作的恢复路径，而不是白屏。
 * 本地优先应用尤其重要 — IndexedDB 结构升级失败等 Dexie 错误会在 render 期抛出，
 * 数据还在磁盘上，刷新/清库提示能让用户自救。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('渲染崩溃', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="card p-6 max-w-[520px] w-full">
          <div className="text-lg font-semibold text-danger mb-2">应用遇到错误</div>
          <p className="text-sm text-text-2 mb-1">
            界面渲染出错，但本地数据仍在。先试重新加载；若反复出现，可导出数据后重置。
          </p>
          <pre className="text-[11px] text-text-3 bg-bg-overlay rounded-lg p-3 max-h-[180px] overflow-auto whitespace-pre-wrap mb-4">
            {error.message}
            {error.stack ? `\n${error.stack.split('\n').slice(1, 5).join('\n')}` : ''}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={() => location.reload()}
              className="btn-primary h-9 px-4 text-sm"
            >
              重新加载
            </button>
            <a
              href="mailto:fangchen@secondplanet.cc?subject=拾贝%20错误报告"
              className="btn-ghost h-9 px-4 text-sm"
            >
              反馈问题
            </a>
          </div>
        </div>
      </div>
    )
  }
}