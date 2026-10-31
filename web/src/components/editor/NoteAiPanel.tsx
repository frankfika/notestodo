import { useState } from 'react'
import { callLLM } from '../../llm/client'
import { useSettings } from '../../db/settings'
import { resolveLLMConfig } from '../../types'

export interface NoteAiPanelProps {
  noteTitle: string
  getBodyMarkdown: () => string
  onInsert: (md: string) => void
}

interface AiResult {
  id: number
  label: string
  text: string
}

type ActionKey = 'summarize' | 'continue' | 'todos'

const ACTIONS: Array<{ key: ActionKey; label: string; prompt: string }> = [
  {
    key: 'summarize',
    label: '总结本页',
    prompt: '请用简洁的中文要点总结下面这篇笔记的核心内容，输出 Markdown 列表。',
  },
  {
    key: 'continue',
    label: '续写一段',
    prompt: '请顺着下面这篇笔记的内容和语气，自然地续写一段（Markdown 格式），不要重复已有内容。',
  },
  {
    key: 'todos',
    label: '提取待办',
    prompt: '请从下面这篇笔记中提取所有待办事项，输出 Markdown 任务列表（- [ ] 格式）。没有待办就说明没有。',
  },
]

export function NoteAiPanel({ noteTitle, getBodyMarkdown, onInsert }: NoteAiPanelProps) {
  const settings = useSettings()
  const [results, setResults] = useState<AiResult[]>([])
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  const configured = settings
    ? (() => {
        const cfg = resolveLLMConfig(settings)
        return cfg.provider === 'builtin' || cfg.is_local || !!cfg.api_key
      })()
    : false

  async function run(key: ActionKey) {
    if (!settings || busy) return
    const action = ACTIONS.find((a) => a.key === key)!
    setBusy(key)
    setError(null)
    try {
      const body = getBodyMarkdown()
      const reply = await callLLM(settings, [
        { role: 'system', content: action.prompt },
        { role: 'user', content: `笔记标题：${noteTitle}\n\n${body || '（正文为空）'}` },
      ], { maxTokens: 1024, temperature: 0.3 })
      setResults((prev) => [{ id: Date.now(), label: action.label, text: reply.trim() }, ...prev])
    } catch (e) {
      setError(e instanceof Error ? e.message : '调用失败')
    } finally {
      setBusy(null)
    }
  }

  if (!configured) {
    return (
      <div className="p-4 text-sm text-text-3">
        还没有配置 AI。去「设置 → AI」配置后即可使用。
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-2 p-3 border-b border-line">
        {ACTIONS.map((a) => (
          <button
            key={a.key}
            type="button"
            className="btn-ghost"
            disabled={busy !== null}
            onClick={() => void run(a.key)}
          >
            {busy === a.key ? '生成中…' : a.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {error && <div className="card p-3 text-sm text-danger">{error}</div>}
        {results.length === 0 && !error && (
          <div className="text-sm text-text-3 px-1">点上方按钮，对当前笔记执行 AI 操作。</div>
        )}
        {results.map((r) => (
          <div key={r.id} className="card p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-text-3">{r.label}</span>
              <button
                type="button"
                className="btn-ghost !px-2 !py-1 text-xs"
                onClick={() => onInsert(r.text)}
              >
                插入到文末
              </button>
            </div>
            <div className="whitespace-pre-wrap text-sm text-text-1">{r.text}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
