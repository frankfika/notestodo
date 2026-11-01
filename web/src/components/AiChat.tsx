import { useEffect, useRef, useState } from 'react'
import { getSettings } from '../db/settings'
import type { ChatMessage } from '../llm/client'
import { askAgent, type AgentAction } from '../lib/aiAgent'
import { executeAction, isRisky, type ActionOutcome } from '../lib/aiActions'
import type { Source } from '../lib/retrieve'
import MissingModelCard, { isModelMissing } from './MissingModelCard'

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  /** 已执行的动作 */
  done?: ActionOutcome[]
  /** 待确认的动作（破坏性） */
  pending?: { action: AgentAction; label: string }[]
  /** 被撤销的动作索引 */
  undone?: number[]
  /** T 编号 → todo id，执行待确认动作时要用 */
  taskIds?: Map<string, string>
}

export const QUICK_PROMPTS = [
  '总结我今天记了什么',
  '列出本周到期的任务',
  '我有哪些待办来自会议？',
  '新建任务：明天交方案 @张三',
  '把这周过期的任务列出来',
]

/** 共享聊天组件：抽屉（⌘J）与首页工作台共用同一套逻辑 */
export default function AiChat({
  variant,
  autoFocus = false,
}: {
  variant: 'page' | 'drawer'
  autoFocus?: boolean
}): JSX.Element {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, busy])

  async function send(text: string): Promise<void> {
    const q = text.trim()
    if (!q || busy) return
    setErr(null)
    setBusy(true)
    setInput('')
    const history: ChatMsg[] = [...messages, { role: 'user', content: q }]
    setMessages(history)
    try {
      // 离线 + 云端 AI：别发网络请求，直接说清怎么办（本机模型不受影响，照常跑）
      if (!navigator.onLine) {
        const settings = await getSettings()
        if (settings.ai_mode === 'cloud') {
          setErr('当前离线。云端 AI 需要网络；可在 设置 → AI 运行哪里 切到「本机内置」离线使用。')
          return
        }
      }
      const llmHistory: ChatMessage[] = history
        .filter((m) => m.role === 'user' || m.content)
        .map((m) => ({ role: m.role, content: m.content }))
      const result = await askAgent(llmHistory, q)

      // 破坏性动作先确认，其余直接执行
      const safe: AgentAction[] = []
      const risky: AgentAction[] = []
      for (const a of result.actions) (isRisky(a) ? risky : safe).push(a)

      const done: ActionOutcome[] = []
      for (const a of safe) {
        const outcome = await executeAction(a, result.taskIds)
        if (outcome.ok) done.push(outcome)
      }
      const pending = risky.map((a) => ({ action: a, label: a.title ?? a.task_id ?? '' }))

      setMessages([
        ...history,
        { role: 'assistant', content: result.reply, sources: result.sources, done, pending, taskIds: result.taskIds },
      ])
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function confirm(msgIndex: number, pendingIndex: number): Promise<void> {
    const msg = messages[msgIndex]
    const item = msg?.pending?.[pendingIndex]
    if (!msg || !item) return
    const outcome = await executeAction(item.action, msg.taskIds ?? new Map())
    setMessages((prev) => {
      const next = [...prev]
      const cur = { ...next[msgIndex] }
      const pending = (cur.pending ?? []).filter((_, i) => i !== pendingIndex)
      const done = outcome.ok ? [...(cur.done ?? []), outcome] : (cur.done ?? [])
      next[msgIndex] = { ...cur, pending, done }
      return next
    })
  }

  async function undo(msgIndex: number, doneIndex: number): Promise<void> {
    const outcome = messages[msgIndex]?.done?.[doneIndex]
    if (!outcome?.undo) return
    await outcome.undo()
    setMessages((prev) => {
      const next = [...prev]
      const cur = { ...next[msgIndex] }
      next[msgIndex] = { ...cur, undone: [...(cur.undone ?? []), doneIndex] }
      return next
    })
  }

  return (
    <>
      <div ref={listRef} className={`flex-1 overflow-y-auto px-4 py-4 space-y-3 ${messages.length === 0 ? 'flex flex-col justify-center' : ''}`}>
        {messages.length === 0 && (
          <div className="space-y-4">
            <p className="text-center text-text-3 text-sm">
              问问题，或直接让我做事——「新建任务：明天交方案 @张三」
            </p>
            <div className="flex flex-col items-center gap-2">
              {QUICK_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => void send(p)}
                  className="chip hover:border-accent hover:text-accent transition-colors"
                >{p}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words ${
              m.role === 'user'
                ? 'bg-accent text-accent-contrast rounded-br-md'
                : 'bg-bg-overlay text-text-1 rounded-bl-md border border-line'
            }`}>
              {m.content}
              {m.sources && m.sources.length > 0 && (
                <div className="mt-2 pt-2 border-t border-line/60 text-[11px] text-text-3">
                  引用了 {m.sources.length} 条：{m.sources.map((s) => `《${s.title}》`).join('、')}
                </div>
              )}
              {m.done && m.done.length > 0 && (
                <div className="mt-2 pt-2 border-t border-line/60 space-y-1">
                  {m.done.map((o, j) => (
                    <div key={j} className="flex items-center gap-2 text-[11.5px]">
                      <span className={o.ok ? 'text-text-2' : 'text-danger'}>{o.ok ? '✓' : '✕'} {o.label}</span>
                      {m.undone?.includes(j) ? (
                        <span className="text-text-3">已撤销</span>
                      ) : o.undo ? (
                        <button onClick={() => void undo(i, j)} className="text-accent hover:underline">撤销</button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              {m.pending && m.pending.length > 0 && (
                <div className="mt-2 pt-2 border-t border-line/60 space-y-1">
                  {m.pending.map((p, j) => (
                    <div key={j} className="flex items-center gap-2 text-[11.5px]">
                      <span className="text-warning">待确认：{p.label}</span>
                      <button onClick={() => void confirm(i, j)} className="text-accent hover:underline">执行</button>
                      <button
                        onClick={() => setMessages((prev) => {
                          const next = [...prev]
                          const msg = { ...next[i] }
                          next[i] = { ...msg, pending: (msg.pending ?? []).filter((_, k) => k !== j) }
                          return next
                        })}
                        className="text-text-3 hover:text-text-1"
                      >取消</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="bg-bg-overlay border border-line rounded-2xl rounded-bl-md px-3.5 py-2 text-[13px] text-text-3">
              <span className="rec-dot">●</span> 思考中…
            </div>
          </div>
        )}
        {err && (
          isModelMissing(err) ? (
            <MissingModelCard err={err} />
          ) : (
            <div className="text-xs text-danger text-center">{err}</div>
          )
        )}
      </div>

      <div className="border-t border-line p-3 shrink-0">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send(input)
            }
          }}
          rows={2}
          className="input text-sm"
          placeholder={variant === 'page'
            ? '问点什么，或直接让我做事（Enter 发送，Shift+Enter 换行）'
            : '问点什么…（Enter 发送，Shift+Enter 换行）'}
          disabled={busy}
          autoFocus={autoFocus}
        />
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[11px] text-text-3">⌘J 随时唤起</span>
          <button
            onClick={() => void send(input)}
            disabled={busy || !input.trim()}
            className="btn-primary text-xs h-7 ml-auto"
          >发送</button>
        </div>
      </div>
    </>
  )
}
