import AiChat from '../../components/AiChat'

/**
 * AI 工作台（首页）：Notion AI 式——一个入口，既能问，也能让 AI 直接动手
 * （建任务 / 改任务 / 建笔记）。破坏性操作会先请用户确认。
 */
export default function AiHomePage(): JSX.Element {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-5 h-12 border-b border-line shrink-0">
        <span className="text-accent">✦</span>
        <span className="text-sm font-medium text-text-1">AI 工作台</span>
        <span className="text-[11px] text-text-3">上下文：笔记 + 任务 + 会议 · 能问，也能动手</span>
      </div>
      <div className="flex-1 min-h-0 flex justify-center">
        <div className="w-full max-w-3xl flex flex-col min-h-0">
          <AiChat variant="page" />
        </div>
      </div>
    </div>
  )
}
