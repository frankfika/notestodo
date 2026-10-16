import { catalogById, isReady, mockEnabled } from '../lib/builtinModels'
import { isTauri } from '../lib/tauri'
import { invoke } from '../lib/tauriInvoke'
import type { ChatMessage } from './client'

/** 内置模型缺失时的统一错误前缀：pipeline 据此在模型下载完成后自动续跑 */
export const MODEL_MISSING = '内置模型未下载'

export function requireModel(id: string): { id: string; file: string; name: string } {
  const m = catalogById(id)
  if (!m) throw new Error(`${MODEL_MISSING}：未知模型 ${id}`)
  if (!isReady(id)) throw new Error(`${MODEL_MISSING}：${m.name}。到「设置 → AI 运行在哪里」下载后会自动继续。`)
  return { id, file: m.file, name: m.name }
}

/** 应用内置 Gemma 4（llama.cpp，进程内推理）。Rust 命令：builtin_llm_chat */
export async function callBuiltinLLM(
  modelId: string,
  messages: ChatMessage[],
  opts: { jsonMode: boolean; maxTokens: number; temperature: number },
): Promise<string> {
  const m = requireModel(modelId)
  if (!isTauri() && mockEnabled()) return mockReply(messages, opts.jsonMode)
  return invoke<string>('builtin_llm_chat', {
    model: m.id, file: m.file, messages,
    maxTokens: opts.maxTokens, temperature: opts.temperature, json: opts.jsonMode,
  })
}

// DEV 模拟：给出结构正确、明确标注「模拟」的输出，便于走通 UX
async function mockReply(messages: ChatMessage[], json: boolean): Promise<string> {
  await new Promise((r) => setTimeout(r, 800))
  if (!json) return '（开发模拟回复）内置模型尚未接入真实推理，这是占位回答。'
  const user = messages.find((m) => m.role === 'user')?.content ?? ''
  const firstLine = /\] [^:]+: (.+)/.exec(user)?.[1] ?? '会议内容'
  return JSON.stringify({
    title: '（模拟）本地模型会议笔记',
    summary_md: `## 要点\n- ${firstLine}\n\n> 开发模式模拟输出：真实推理由应用内置 Gemma 4 完成。`,
    decisions: [],
    todos: [{ title: '（模拟）跟进会议要点', assignee_hint: '', due_hint: '', evidence_quote: firstLine, evidence_time: '00:00' }],
  })
}
