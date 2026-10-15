import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { now, uid } from '../lib/id'
import { parseQuickAdd } from '../lib/quickAdd'
import { levelLabel, suggestKr } from '../lib/okr'

/**
 * 一行录入任务：输入「周五前交方案 @张三」回车即建。
 * 边打边预览解析出的截止日 / 负责人 / 建议 KR；建议 KR 默认挂上，点 chip 取消则进 Inbox。
 */
export default function QuickAddBar({ placeholder = '+ 记一件事：「周五前交方案 @张三」回车' }: { placeholder?: string }): JSX.Element {
  const [v, setV] = useState('')
  const [skipKr, setSkipKr] = useState(false)
  const krs = useLiveQuery(
    () => db.todos.where('kind').equals('kr').and((k) => k.deleted_at === null && k.status === 'open').toArray(),
    [],
  ) ?? []
  const parsed = useMemo(() => parseQuickAdd(v), [v])
  const kr = useMemo(() => (v.trim() ? suggestKr(parsed.title, krs) : null), [parsed.title, krs, v])
  const target = skipKr ? null : kr

  async function submit(): Promise<void> {
    if (!v.trim()) return
    const ts = now()
    await db.todos.add({
      id: uid(), kind: 'task', parent_id: target?.id ?? null, scope: target?.scope ?? null,
      title: parsed.title, due_date: parsed.due_date, assignee: parsed.assignee,
      status: 'open', source: 'manual', sort_order: Date.now(),
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
    setV('')
    setSkipKr(false)
  }

  const hasMeta = v.trim() && (parsed.due_date || parsed.assignee || kr)
  return (
    <div>
      <input
        value={v}
        onChange={(e) => { setV(e.target.value); setSkipKr(false) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submit() } }}
        placeholder={placeholder}
        aria-label="快速新建任务"
        className="input h-9 text-sm"
      />
      {hasMeta && (
        <div className="flex flex-wrap items-center gap-2 mt-1.5 px-1 text-[11px] text-text-3">
          {parsed.due_date && <span>截止 {parsed.due_date}</span>}
          {parsed.assignee && <span>@{parsed.assignee}</span>}
          {kr && (
            <button
              type="button"
              onClick={() => setSkipKr((x) => !x)}
              className={`px-1.5 rounded border transition-colors ${target ? 'border-accent/40 bg-accent/8 text-accent' : 'border-line line-through'}`}
              title={target ? '点一下改为只进 Inbox' : '点一下挂到这个 KR'}
            >→ {levelLabel(kr)} · {kr.title}</button>
          )}
          {!target && <span>→ Inbox</span>}
        </div>
      )}
    </div>
  )
}
