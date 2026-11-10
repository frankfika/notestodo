import type { JSX } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import AiChat from '../../components/AiChat'
import EmptyState from '../../components/EmptyState'
import { db } from '../../db/db'
import { createPage } from '../../lib/notes'
import { useRecorder } from '../../state/recorder'
import { useUI } from '../../state/ui'

/**
 * AI 工作台：Notion AI 式——一个入口，既能问，也能让 AI 直接动手
 * （建任务 / 改任务 / 建笔记）。破坏性操作会先请用户确认。
 */
export default function AiHomePage(): JSX.Element {
  const start = useRecorder((s) => s.start)
  const goNote = useUI((s) => s.goNote)
  const notes = useLiveQuery(() => db.notes.filter((n) => n.deleted_at === null).count(), []) ?? 0
  const todos = useLiveQuery(() => db.todos.filter((t) => t.deleted_at === null).count(), []) ?? 0
  const meetings = useLiveQuery(() => db.meetings.filter((m) => m.deleted_at === null).count(), []) ?? 0
  const empty = notes === 0 && todos === 0 && meetings === 0

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-5 h-12 border-b border-line shrink-0">
        <span className="text-accent">✦</span>
        <span className="text-sm font-medium text-text-1">AI 工作台</span>
        <span className="text-[11px] text-text-3">上下文：笔记 + 任务 + 会议 · 能问，也能动手</span>
      </div>
      <div className="flex-1 min-h-0 flex justify-center">
        <div className="w-full max-w-3xl flex flex-col min-h-0">
          <div className="px-4 pt-3 shrink-0">
            {empty ? (
              <EmptyState
                compact
                icon="✦"
                title="AI 还没有可引用的内容"
                hint="先记一条笔记或开一场会，AI 才能引用它们来总结、追问和跟进。"
                action={
                  <button onClick={() => void start()} className="btn-primary h-7 text-xs shrink-0">● 开始录音</button>
                }
                secondary={
                  <button
                    onClick={() => void createPage(null, null).then((id) => goNote(id))}
                    className="btn-outline h-7 text-xs shrink-0"
                  >＋ 新建笔记</button>
                }
              />
            ) : (
              <div className="text-[11px] text-text-3">
                可引用：{notes} 条笔记 · {todos} 个任务 · {meetings} 场会议
              </div>
            )}
          </div>
          <AiChat variant="page" />
        </div>
      </div>
    </div>
  )
}
