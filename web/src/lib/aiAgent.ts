import { db } from '../db/db'
import { getSettings } from '../db/settings'
import { callLLM, type ChatMessage } from '../llm/client'
import { resolveLLMConfig } from '../types'
import { searchSources, type Source } from './retrieve'

/**
 * AI 助手（可动手版）：LLM 输出 { reply, actions[] }，本地执行动作。
 * 不用 tool-calling —— 任何 OpenAI/Anthropic 兼容端点（含本机 Gemma）都能跑。
 *
 * 动作类型：
 *   create_task   { title, due_date?, assignee?, note? }
 *   update_task   { task_id, title?, due_date?, assignee? }
 *   complete_task { task_id }
 *   delete_task   { task_id }        ← 破坏性，UI 需确认
 *   create_note   { title, body_md? }
 */

export interface AgentAction {
  type: 'create_task' | 'update_task' | 'complete_task' | 'delete_task' | 'create_note'
  task_id?: string
  title?: string
  body_md?: string
  due_date?: string
  assignee?: string
  note?: string
}

export interface AgentResult {
  reply: string
  actions: AgentAction[]
  sources: Source[]
  /** 任务 id ↔ 上下文里的 T1/T2 短号映射（用于把 LLM 的引用解析回真 id） */
  taskIds: Map<string, string>
}

const MAX_TASKS_IN_CONTEXT = 60

/** 拉上下文：相关笔记/会议 + 全部进行中任务（带 T1/T2 短号） */
export async function buildAgentContext(query: string): Promise<{
  sources: Source[]
  taskIds: Map<string, string>
  taskDigest: string
}> {
  const [sources, todosRaw] = await Promise.all([
    searchSources(query),
    db.todos
      .filter((t) => t.deleted_at === null && t.status !== 'cancelled')
      .toArray(),
  ])
  const todos = todosRaw
    .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
    .slice(0, MAX_TASKS_IN_CONTEXT)
  const taskIds = new Map<string, string>()
  const taskDigest = todos
    .map((t, i) => {
      const short = `T${i + 1}`
      taskIds.set(short, t.id)
      const bits = [`[${short}] ${t.title || '（无标题）'}`]
      if (t.due_date) bits.push(`截止 ${t.due_date}`)
      if (t.assignee) bits.push(`负责人 ${t.assignee}`)
      if (t.status === 'done') bits.push('已完成')
      if (t.source === 'meeting') bits.push('来自会议')
      return `- ${bits.join(' · ')}`
    })
    .join('\n')
  return { sources, taskIds, taskDigest }
}

const SYSTEM = (taskDigest: string, sources: Source[]): string => `你是用户个人工作区（笔记 + 任务 + 会议纪要）的 AI 助手。用中文简洁回答，只基于下面的上下文，不知道就说不知道。

你还能直接动手：把需要执行的操作放进 actions 数组，AI 助手会替你做（删除类操作会先请用户确认）。没有要执行的操作时 actions 为空数组。

## 当前任务列表（${taskDigest ? '有' : '无'}）
${taskDigest || '（无任务）'}

## 相关内容（笔记 / 会议转录摘录）
${sources.map((s, i) => `[${i + 1}] 《${s.title}》：${s.snippet}`).join('\n\n') || '（未检索到相关内容）'}

只输出 JSON，不要任何多余文字：
{"reply":"给用户看的中文回答","actions":[{"type":"create_task|update_task|complete_task|delete_task|create_note","task_id":"T1","title":"...","due_date":"YYYY-MM-DD","assignee":"...","body_md":"...","note":"..."}]}

规则：
- 日期用 YYYY-MM-DD；用户说「明天/下周三」等相对时间时，换算成绝对日期再填。
- 改/完成/删除已有任务时，task_id 必须用上下文里的 T 编号。
- 不要凭空编造任务列表里没有的 T 编号。`

/** 调模型并解析 {reply, actions} */
export async function askAgent(history: ChatMessage[], query: string): Promise<AgentResult> {
  const settings = await getSettings()
  const llm = resolveLLMConfig(settings)
  if (llm.provider !== 'builtin' && !llm.is_local && !llm.api_key) {
    throw new Error('还没有配置 AI。')
  }
  const { sources, taskIds, taskDigest } = await buildAgentContext(query)
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM(taskDigest, sources) },
    ...history.slice(-10),
  ]
  const raw = await callLLM(settings, messages, { maxTokens: 1200, temperature: 0.2, jsonMode: true })
  return { ...parseAgentJson(raw), sources, taskIds }
}

/** 模型可能返回 ```json 包裹或夹杂前后缀，容错解析 */
export function parseAgentJson(raw: string): { reply: string; actions: AgentAction[] } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  const jsonText = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
  try {
    const obj = JSON.parse(jsonText) as { reply?: unknown; actions?: unknown }
    const reply = typeof obj.reply === 'string' && obj.reply.trim() ? obj.reply.trim() : raw.trim()
    const actions = Array.isArray(obj.actions)
      ? (obj.actions as AgentAction[]).filter((a) => a && typeof a.type === 'string')
      : []
    return { reply, actions }
  } catch {
    // 不是 JSON：当作纯文本回答（模型没听话时也要有输出，不能白屏）
    return { reply: raw.trim(), actions: [] }
  }
}
