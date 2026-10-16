import { resolveLLMConfig } from '../../types'
import { useUI } from '../../state/ui'
import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { emptyCustomTemplate } from '../../db/seed'
import { getSettings } from '../../db/settings'
import { renderTemplate } from '../../llm/prompts'
import { callLLM } from '../../llm/client'
import { now, uid } from '../../lib/id'
import type { SummaryTemplate } from '../../types'
import EmptyState from '../../components/EmptyState'

/**
 * 模板编辑页：左列模板列表（🔒 builtin 标记只读）+ 右列编辑器。
 * 「试运行」按钮尝试调 Agent A 的 renderTemplate + callLLM；若 LLM client
 * 还没接，提示「需要在设置里填好 API Key 并由 Agent A 实现 LLM client」。
 */
export default function TemplatesPage(): JSX.Element {
  const templates = useLiveQuery(
    () => db.templates.toArray(),
    [],
  ) ?? []

  const [selectedId, setSelectedId] = useState<string | null>(null)
  // 默认选 builtin-default
  useEffect(() => {
    if (selectedId) return
    const def = templates.find((t) => t.is_default)
    if (def) setSelectedId(def.id)
  }, [templates, selectedId])

  const selected = useMemo(() => templates.find((t) => t.id === selectedId) ?? null, [templates, selectedId])

  async function createTemplate(): Promise<void> {
    const t = emptyCustomTemplate()
    await db.templates.add(t)
    setSelectedId(t.id)
  }

  async function duplicateTemplate(src: SummaryTemplate): Promise<void> {
    const t: SummaryTemplate = {
      ...src,
      id: uid(),
      name: src.name + ' 副本',
      icon: src.icon,
      is_default: false,
      builtin: false,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
      sync_version: 0,
    }
    await db.templates.add(t)
    setSelectedId(t.id)
  }

  async function deleteTemplate(t: SummaryTemplate): Promise<void> {
    if (t.builtin) return
    if (!window.confirm(`删除自定义模板「${t.name}」？`)) return
    await db.templates.delete(t.id)
    if (selectedId === t.id) setSelectedId(null)
  }

  return (
    <div className="h-full flex">
      <aside className="w-[260px] shrink-0 border-r border-line overflow-y-auto">
        <div className="px-4 py-4 border-b border-line flex items-center">
          <button onClick={() => useUI.getState().goSettings()} className="icon-btn -ml-1 mr-1 !h-7 !w-7" aria-label="返回设置" title="返回设置">←</button>
          <h1 className="text-sm font-semibold text-text-1">模板</h1>
          <span className="ml-2 text-[11px] text-text-3 tabular-nums">{templates.length}</span>
          <button onClick={() => void createTemplate()} className="ml-auto btn-outline text-xs h-7 px-2">+ 新建</button>
        </div>

        {templates.length === 0 ? (
          <EmptyState icon="◌" title="没有模板" hint="通常由 Agent A 注入三套内置模板。" />
        ) : (
          <ul className="py-1">
            {templates.map((t) => {
              const active = selectedId === t.id
              return (
                <li key={t.id} className="group">
                  <button
                    onClick={() => setSelectedId(t.id)}
                    className={`w-full flex items-center gap-2 px-4 py-2.5 text-left transition-colors ${
                      active ? 'bg-bg-overlay' : ''
                    } hover:bg-bg-overlay/50`}
                  >
                    <span className="text-base">{t.icon}</span>
                    <span className="flex-1 min-w-0">
                      <div className="text-sm text-text-1 truncate">{t.name}</div>
                      <div className="text-[11px] text-text-3 mt-0.5">
                        {t.builtin ? '🔒 内置只读' : '自定义'}
                        {t.is_default && ' · 默认'}
                      </div>
                    </span>
                    {!t.builtin && (
                      <span
                        onClick={(e) => { e.stopPropagation(); void deleteTemplate(t) }}
                        className="opacity-0 group-hover:opacity-100 icon-btn !h-6 !w-6 text-text-3 hover:text-danger"
                        title="删除"
                      >✕</span>
                    )}
                  </button>
                  {!t.builtin && (
                    <div className="px-12 -mt-1">
                      <button
                        onClick={() => void duplicateTemplate(t)}
                        className="text-[11px] text-text-3 hover:text-text-1"
                      >复制为新模板</button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto">
        {selected ? (
          <TemplateEditor template={selected} />
        ) : (
          <div className="h-full flex items-center justify-center">
            <EmptyState icon="▤" title="选择左侧模板" hint="或在左侧点 + 新建。" />
          </div>
        )}
      </main>
    </div>
  )
}

function TemplateEditor({ template }: { template: SummaryTemplate }): JSX.Element {
  const [name, setName] = useState(template.name)
  const [icon, setIcon] = useState(template.icon)
  const [promptMd, setPromptMd] = useState(template.prompt_md)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setName(template.name); setIcon(template.icon); setPromptMd(template.prompt_md); setDirty(false)
  }, [template.id])

  useEffect(() => {
    setDirty(name !== template.name || icon !== template.icon || promptMd !== template.prompt_md)
  }, [name, icon, promptMd, template.name, template.icon, template.prompt_md])

  async function save(): Promise<void> {
    if (template.builtin) return
    await db.templates.update(template.id, {
      name: name.trim() || template.name,
      icon: icon || template.icon,
      prompt_md: promptMd,
      updated_at: now(),
    })
    setDirty(false)
  }

  async function tryRun(): Promise<void> {
    try {
      const settings = await getSettings()
      // 本地模型（Ollama 等）无需 Key：按当前生效配置判断，而不是只看云端 Key
      const llm = resolveLLMConfig(settings)
      if (!llm.is_local && !llm.api_key) {
        window.alert('请先在「设置」页填好 LLM API Key。')
        return
      }
      const vars = {
        'meeting.title': '示例会议',
        'meeting.date': new Date().toISOString().slice(0, 10),
        'meeting.duration': '30m',
        'transcript.full': '[00:00–00:30] 说话人 1: 这是一条示例转录，用于试运行模板。',
        'transcript.speakers': '说话人 1',
      }
      const rendered = renderTemplate(promptMd, vars)
      const out = await callLLM(settings, [
        { role: 'system', content: '你是会议纪要助手。' },
        { role: 'user', content: rendered },
      ], { maxTokens: 500 })
      window.alert('试运行结果：\n\n' + out.slice(0, 1000))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      window.alert('试运行失败：' + msg)
    }
  }

  return (
    <div className="max-w-[820px] mx-auto px-6 py-8">
      <div className="flex items-center gap-2 mb-3">
        <input
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          disabled={template.builtin}
          className="h-9 w-10 text-center text-xl bg-bg-overlay border border-line rounded-md disabled:opacity-60"
          aria-label="图标"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={template.builtin}
          className="flex-1 h-9 px-3 bg-bg-overlay border border-line rounded-md text-sm text-text-1 disabled:opacity-60 outline-none"
          placeholder="模板名称"
        />
        {!template.builtin && (
          <button onClick={() => void save()} disabled={!dirty} className="btn-primary text-sm h-9 px-3">
            {dirty ? '保存' : '已保存'}
          </button>
        )}
      </div>

      {template.builtin && (
        <div className="mb-3 text-[11px] text-text-3">
          🔒 内置模板只读。如需修改，请先复制为新模板。
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="px-3 py-2 border-b border-line flex items-center text-xs text-text-3">
          <span>prompt.md · 支持 <code className="kbd">{`{{meeting.title}}`}</code> 等变量</span>
        </div>
        <textarea
          value={promptMd}
          onChange={(e) => setPromptMd(e.target.value)}
          disabled={template.builtin}
          spellCheck={false}
          className="w-full min-h-[60vh] p-4 bg-transparent font-mono text-[13px] leading-[1.7] text-text-1 outline-none resize-y disabled:opacity-60"
        />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button onClick={() => void tryRun()} className="btn-outline text-sm h-9">
          ▶ 试运行
        </button>
        <span className="text-[11px] text-text-3">用最近一次会议测试；需要先在设置里配好模型（云端 Key 或本地模型）。</span>
      </div>
    </div>
  )
}