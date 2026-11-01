import { db } from '../db/db'
import { now, uid } from '../lib/id'
import { parseQuickAdd } from './quickAdd'
import { createPage } from './notes'
import type { AgentAction } from './aiAgent'

/**
 * AI 动作执行层：每个动作都能回滚（undo），删除类动作标记 risky 由 UI 先确认。
 *  ponytail: 只做 5 种动作，不做通用脚本执行 —— 能预测比能折腾重要。
 */

export interface ActionOutcome {
  action: AgentAction
  ok: boolean
  /** 人话描述，显示在操作卡上 */
  label: string
  /** 需要用户确认才执行（删除） */
  risky: boolean
  undo?: () => Promise<void>
  error?: string
}

const DESTRUCTIVE = new Set(['delete_task'])

export function isRisky(action: AgentAction): boolean {
  return DESTRUCTIVE.has(action.type)
}

/** 把 LLM 的 T 编号解析成真实 todo id */
function resolveId(action: AgentAction, taskIds: Map<string, string>): string | null {
  if (!action.task_id) return null
  return taskIds.get(action.task_id) ?? (taskIds.get(action.task_id.toUpperCase()) ?? null)
}

export async function executeAction(
  action: AgentAction,
  taskIds: Map<string, string>,
): Promise<ActionOutcome> {
  const ts = now()
  switch (action.type) {
    case 'create_task': {
      const rawTitle = (action.title ?? '').trim()
      if (!rawTitle) return { action, ok: false, risky: false, label: '创建任务', error: '缺少任务标题' }
      // 标题里可能带「明天 交方案 @张三」——没给 due_date 时自己解析
      const parsed = action.due_date ? { title: rawTitle, due_date: action.due_date, assignee: action.assignee } : parseQuickAdd(rawTitle)
      const id = uid()
      await db.todos.add({
        id, kind: 'task', parent_id: null, scope: null,
        title: parsed.title || rawTitle, status: 'open', source: 'manual',
        sort_order: Date.now(), created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
        ...(parsed.due_date ? { due_date: parsed.due_date } : {}),
        ...(parsed.assignee ? { assignee: parsed.assignee } : {}),
        ...(action.note ? { notes_md: action.note } : {}),
      })
      const when = parsed.due_date ? ` · 截止 ${parsed.due_date}` : ''
      return {
        action, ok: true, risky: false,
        label: `新建任务「${parsed.title || rawTitle}」${when}`,
        undo: async () => { await db.todos.delete(id) },
      }
    }
    case 'create_note': {
      const title = (action.title ?? '').trim() || '未命名笔记'
      const id = await createPage(null)
      await db.notes.update(id, { title, body_md: action.body_md ?? '' })
      return {
        action, ok: true, risky: false,
        label: `新建笔记「${title}」`,
        undo: async () => { await db.notes.update(id, { deleted_at: ts }) },
      }
    }
    case 'complete_task': {
      const id = resolveId(action, taskIds)
      const t = id ? await db.todos.get(id) : undefined
      if (!t) return { action, ok: false, risky: false, label: '完成任务', error: '找不到目标任务' }
      await db.todos.update(t.id, { status: 'done', updated_at: ts, sync_version: t.sync_version + 1 })
      return {
        action, ok: true, risky: false,
        label: `完成「${t.title || '（无标题）'}」`,
        undo: async () => { await db.todos.update(t.id, { status: t.status, updated_at: ts }) },
      }
    }
    case 'update_task': {
      const id = resolveId(action, taskIds)
      const t = id ? await db.todos.get(id) : undefined
      if (!t) return { action, ok: false, risky: false, label: '修改任务', error: '找不到目标任务' }
      const patch: Record<string, unknown> = { updated_at: ts, sync_version: t.sync_version + 1 }
      if (action.title?.trim()) patch.title = action.title.trim()
      if (action.due_date) patch.due_date = action.due_date
      if (action.assignee) patch.assignee = action.assignee
      await db.todos.update(t.id, patch)
      const what = [
        action.title?.trim() ? `标题→${action.title.trim()}` : '',
        action.due_date ? `截止→${action.due_date}` : '',
        action.assignee ? `负责人→${action.assignee}` : '',
      ].filter(Boolean).join('，')
      return {
        action, ok: true, risky: false,
        label: `修改「${t.title || '（无标题）'}」${what ? `（${what}）` : ''}`,
        undo: async () => {
          await db.todos.update(t.id, {
            title: t.title, due_date: t.due_date, assignee: t.assignee, updated_at: ts,
          })
        },
      }
    }
    case 'delete_task': {
      const id = resolveId(action, taskIds)
      const t = id ? await db.todos.get(id) : undefined
      if (!t) return { action, ok: false, risky: true, label: '删除任务', error: '找不到目标任务' }
      await db.todos.update(t.id, { deleted_at: ts, updated_at: ts })
      return {
        action, ok: true, risky: true,
        label: `删除「${t.title || '（无标题）'}」`,
        undo: async () => { await db.todos.update(t.id, { deleted_at: null, updated_at: ts }) },
      }
    }
    default:
      return { action, ok: false, risky: false, label: '未知操作', error: `不支持的操作 ${action.type}` }
  }
}
