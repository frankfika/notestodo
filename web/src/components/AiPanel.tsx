import { useEffect, useRef, useState } from 'react'
import { db } from '../db/db'
import { getSettings } from '../db/settings'
import { callLLM, type ChatMessage } from '../llm/client'
import { resolveLLMConfig } from '../types'
import { searchSources, type Source } from '../lib/retrieve'
import { useUI } from '../state/ui'
import { MODEL_MISSING } from '../llm/builtin'
import { CATALOG, downloadModel, modelState, useBuiltinModels, type CatalogModel } from '../lib/builtinModels'

/** 缺模型错误 → 可操作的下载卡片（把「语音转录模型」和「笔记模型」说清楚） */
function MissingModelCard({ err }: { err: string }): JSX.Element {
  useBuiltinModels((s) => s.models) // 订阅下载进度
  const nameInErr = /：(.+?)。/.exec(err)?.[1] ?? ''
  const target: CatalogModel | undefined = CATALOG.find((x) => nameInErr.includes(x.name))
  const st = target ? modelState(target.id) : null
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 text-left space-y-2">
      <div className="text-[13px] text-text-1 font-medium">
        还缺{target?.kind === 'asr' ? '语音转录' : '笔记 / 对话'}模型{target ? `「${target.name}」` : ''}
      </div>
      <p className="text-[11.5px] text-text-3 leading-relaxed">
        转录（听懂录音）和笔记（AI 助手 / 整理纪要）是两个独立模型，各下各的——你可能只下了其中一个。
      </p>
      {target && st?.state === 'downloading' ? (
        <p className="text-[11.5px] text-text-2">正在下载…（可离开，后台继续，下好后自动可用）</p>
      ) : target ? (
        <button onClick={() => void downloadModel(target.id)} className="btn-primary text-xs h-7 px-3">
          一键下载（{(target.bytes / 1e9).toFixed(1)}GB）
        </button>
      ) : null}
    </div>
  )
}

interface Msg {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
}

const QUICK_PROMPTS = [
  '总结我今天记了什么',
  '列出本周到期的任务',
  '我有哪些待办来自会议？',
]

/**
 * 全局 AI 抽屉（Notion AI 式）：任何页面 ⌘J / 侧栏 ✦ 唤起。
 * 上下文 = 本地检索到的相关笔记/会议 + 全部进行中任务摘要；历史只存内存。
 */
export default function AiPanel(): JSX.Element | null {
  const open = useUI((s) => s.aiOpen)
  const setAiOpen = useUI((s) => s.setAiOpen)
  const goSettings = useUI((s) => s.goSettings)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [needConfig, setNeedConfig] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, busy])

  if (!open) return null

  async function send(text: string): Promise<void> {
    const q = text.trim()
    if (!q || busy) return
    setErr(null)
    setBusy(true)
    setInput('')
    const history = [...messages, { role: 'user' as const, content: q }]
    setMessages(history)
    try {
      const settings = await getSettings()
      const llm = resolveLLMConfig(settings)
      if (llm.provider !== 'builtin' && !llm.is_local && !llm.api_key) {
        setNeedConfig(true)
        throw new Error('还没有配置 AI。')
      }
      setNeedConfig(false)

      const [sources, openTodos] = await Promise.all([
        searchSources(q),
        db.todos
          .filter((t) => t.deleted_at === null && (t.status === 'open' || t.status === 'pending_review'))
          .toArray(),
      ])
      const todoDigest = openTodos
        .slice(0, 50)
        .map((t) => `- [${t.due_date ?? '无日期'}] ${t.title}${t.source === 'meeting' ? '（来自会议）' : ''}`)
        .join('\n')

      const system = `你是用户个人工作区（笔记 + 任务 + 会议纪要）的 AI 助手。用中文简洁回答；只基于以下上下文，不知道就说不知道。

## 当前进行中的任务（${openTodos.length} 条）
${todoDigest || '（无）'}

## 相关内容（笔记 / 会议转录摘录）
${sources.map((s, i) => `[${i + 1}] 《${s.title}》：${s.snippet}`).join('\n\n') || '（未检索到相关内容）'}`

      const llmInput: ChatMessage[] = [
        { role: 'system', content: system },
        ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
      ]
      const reply = await callLLM(settings, llmInput, { maxTokens: 1024, temperature: 0.3 })
      setMessages([...history, { role: 'assistant', content: reply, sources }])
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside
      aria-label="AI 助手"
      className="drawer-enter fixed inset-0 md:inset-auto md:right-0 md:top-0 md:bottom-0 z-40 w-full md:w-[400px] md:border-l border-line bg-bg-raise flex flex-col md:shadow-2xl"
    >
      <div className="flex items-center gap-2 px-4 h-12 border-b border-line shrink-0">
        <span className="text-accent">✦</span>
        <span className="text-sm font-medium text-text-1">AI 助手</span>
        <span className="text-[11px] text-text-3">上下文：笔记 + 任务 + 会议</span>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} className="btn-ghost text-[11px] h-6 px-2 ml-auto">新对话</button>
        )}
        <button onClick={() => setAiOpen(false)} className={`icon-btn ${messages.length > 0 ? '' : 'ml-auto'}`} title="关闭" aria-label="关闭">✕</button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="pt-6 space-y-4">
            <p className="text-center text-text-3 text-sm">问任何关于你工作区的问题。</p>
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
          err.startsWith(MODEL_MISSING) ? (
            <MissingModelCard err={err} />
          ) : (
          <div className="text-xs text-danger text-center space-y-2">
            <div>{err}</div>
            {needConfig && (
              <button
                onClick={() => { setAiOpen(false); goSettings() }}
                className="btn-primary text-xs h-7"
              >去设置 AI 引擎</button>
            )}
          </div>
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
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          disabled={busy}
          autoFocus
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
    </aside>
  )
}
