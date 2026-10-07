import { useEffect, useRef, useState } from 'react'
import { db } from '../../db/db'
import { DEFAULT_SETTINGS, type AppSettings } from '../../types'
import { getSettings, saveSettings } from '../../db/settings'
import FieldRow from '../../components/FieldRow'

/**
 * 设置页：AI Provider / 语音转录 / 隐私 / 日历 + 导入导出。
 * 导出 v1 仅导出 JSON 元数据（不含音频 blob）；后续做 zip 打包。
 */
export default function SettingsPage(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void getSettings().then((s) => {
      if (active) {
        setSettings(s)
        setLoaded(true)
      }
    })
    return () => { active = false }
  }, [])

  function patch(p: Partial<AppSettings>): void {
    setSettings((cur) => ({ ...cur, ...p }))
    setDirty(true)
  }

  async function save(): Promise<void> {
    await saveSettings(settings)
    setDirty(false)
    flash('已保存')
  }

  function flash(msg: string): void {
    setToast(msg)
    setTimeout(() => setToast(null), 1800)
  }

  if (!loaded) return <div className="p-10 text-text-3 text-sm">加载中…</div>

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-6 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <div className="section-title">SETTINGS</div>
            <h1 className="text-2xl font-semibold text-text-1 mt-1">设置</h1>
          </div>
          <button
            onClick={() => void save()}
            disabled={!dirty}
            className="btn-primary text-sm h-9 px-4"
          >保存修改</button>
        </div>

        <Section title="AI Provider · LLM" desc="总结 / 待办提取都走它。">
          <FieldRow label="Provider">
            <select
              className="input"
              value={settings.llm_provider}
              onChange={(e) => patch({ llm_provider: e.target.value as AppSettings['llm_provider'] })}
            >
              <option value="anthropic-compatible">Anthropic 兼容</option>
              <option value="openai-compatible">OpenAI 兼容</option>
            </select>
          </FieldRow>
          <FieldRow label="Base URL">
            <input
              className="input"
              value={settings.llm_base_url}
              onChange={(e) => patch({ llm_base_url: e.target.value })}
              placeholder="https://api.example.com"
            />
          </FieldRow>
          <FieldRow label="API Key">
            <PasswordInput
              value={settings.llm_api_key}
              onChange={(v) => patch({ llm_api_key: v })}
              placeholder="sk-..."
            />
          </FieldRow>
          <FieldRow label="Model">
            <input
              className="input"
              value={settings.llm_model}
              onChange={(e) => patch({ llm_model: e.target.value })}
              placeholder="claude-3-5-sonnet-..."
            />
          </FieldRow>
        </Section>

        <Section title="语音转录 · ASR" desc="决定录音结束后的转录引擎。">
          <FieldRow label="Provider">
            <select
              className="input"
              value={settings.asr_provider}
              onChange={(e) => patch({ asr_provider: e.target.value as AppSettings['asr_provider'] })}
            >
              <option value="minimax">MiniMax</option>
              <option value="openai-whisper">OpenAI Whisper 兼容</option>
              <option value="deepgram">Deepgram</option>
            </select>
          </FieldRow>
          <FieldRow label="Base URL">
            <input
              className="input"
              value={settings.asr_base_url}
              onChange={(e) => patch({ asr_base_url: e.target.value })}
            />
          </FieldRow>
          <FieldRow label="API Key">
            <PasswordInput
              value={settings.asr_api_key}
              onChange={(v) => patch({ asr_api_key: v })}
            />
          </FieldRow>
          <FieldRow label="Model">
            <input
              className="input"
              value={settings.asr_model}
              onChange={(e) => patch({ asr_model: e.target.value })}
              placeholder="asr-1.0"
            />
          </FieldRow>
        </Section>

        <Section title="隐私" desc="音频归属与外观。">
          <Toggle
            checked={settings.delete_remote_audio}
            onChange={(v) => patch({ delete_remote_audio: v })}
            label="转录后删除云端音频"
            hint="关掉则会保留在供应商的存储里——通常不要。"
          />
          <FieldRow label="主题">
            <select
              className="input"
              value={settings.theme}
              onChange={(e) => patch({ theme: e.target.value as AppSettings['theme'] })}
            >
              <option value="dark">暗色</option>
              <option value="light">亮色</option>
              <option value="system">跟随系统</option>
            </select>
          </FieldRow>
        </Section>

        <Section title="日历" desc="一行一个 .ics 订阅链接；今日页会列出接下来的事件。">
          <IcsListEditor
            urls={settings.calendar_ics_urls}
            onChange={(urls) => patch({ calendar_ics_urls: urls })}
          />
        </Section>

        <Section title="数据" desc="v1 导出 JSON 元数据（音频 blob 暂未打包，zip 待 M2）。">
          <div className="flex items-center gap-2">
            <button onClick={() => void exportData()} className="btn-outline text-sm h-9">
              ⤓ 导出
            </button>
            <ImportButton onImported={() => flash('导入完成 — 正在重载')} />
            <span className="text-[11px] text-text-3">导出 = 单个 .json 文件；导入会覆盖所有实体。</span>
          </div>
        </Section>

        <Section title="诊断">
          <details>
            <summary className="cursor-pointer text-sm text-text-2 hover:text-text-1">查看当前 settings JSON</summary>
            <pre className="mt-3 text-[11px] text-text-3 bg-bg-overlay border border-line rounded-lg p-3 overflow-x-auto">
              {JSON.stringify(settings, null, 2)}
            </pre>
          </details>
        </Section>

        {toast && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-accent text-accent-contrast shadow-lg text-sm">
            {toast}
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="card p-5 mb-4">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-text-1">{title}</h2>
        {desc && <p className="text-[11px] text-text-3 mt-1">{desc}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function PasswordInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }): JSX.Element {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        className="input pr-16 font-mono"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-text-3 hover:text-text-1 px-1.5 py-0.5"
      >
        {show ? '隐藏' : '显示'}
      </button>
    </div>
  )
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-bg-overlay border border-line-strong'}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-bg-raise shadow transition-all ${checked ? 'left-4' : 'left-0.5'}`}
        />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-1">{label}</div>
        {hint && <div className="text-[11px] text-text-3 mt-0.5">{hint}</div>}
      </div>
    </div>
  )
}

function IcsListEditor({ urls, onChange }: { urls: string[]; onChange: (urls: string[]) => void }): JSX.Element {
  const [draft, setDraft] = useState('')
  return (
    <div className="space-y-2">
        {urls.map((u, i) => (
          <div key={i} className="flex items-center gap-2">
            <input className="input font-mono text-xs" value={u} readOnly />
            <button
              type="button"
              onClick={() => onChange(urls.filter((_, idx) => idx !== i))}
              className="icon-btn"
              aria-label="移除"
              title="删除"
            >✕</button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input
            className="input"
            placeholder="https://calendar.example.com/abc.ics"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              if (draft.trim()) {
                onChange([...urls, draft.trim()])
                setDraft('')
              }
            }}
            className="btn-outline text-sm h-9"
          >+ 添加</button>
        </div>
    </div>
  )
}

function ImportButton({ onImported }: { onImported: () => void }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <button onClick={() => ref.current?.click()} className="btn-outline text-sm h-9">
        ⤴ 导入
      </button>
      <input
        ref={ref}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (!f) return
          void doImport(f, onImported)
          e.target.value = ''
        }}
      />
    </>
  )
}

// ── 导出 / 导入 ──────────────────────────────────────────────────

interface ExportShape {
  schema: 'shibei-export'
  version: 1
  exported_at: string
  tables: Record<string, unknown[]>
}

async function exportData(): Promise<void> {
  // 导出 9 张业务表（audioChunks 的 Blob 不能 JSON 化，跳过）
  const tables: ExportShape['tables'] = {}
  for (const name of ['meetings', 'transcripts', 'notes', 'summaries', 'templates', 'todos', 'tags', 'tagBindings', 'chatMessages', 'kv', 'queueJobs'] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (db as any)[name]
    if (!t || typeof t.toArray !== 'function') continue
    tables[name] = await t.toArray()
  }
  const payload: ExportShape = {
    schema: 'shibei-export',
    version: 1,
    exported_at: new Date().toISOString(),
    tables,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  a.href = url
  a.download = `shibei-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function doImport(file: File, onImported: () => void): Promise<void> {
  try {
    const text = await file.text()
    const data = JSON.parse(text) as ExportShape
    if (data.schema !== 'shibei-export') throw new Error('文件格式不匹配 (schema 不为 shibei-export)')
    if (!data.tables || typeof data.tables !== 'object') throw new Error('文件不含 tables')

    if (!window.confirm(`导入 ${Object.keys(data.tables).length} 张表的数据？将覆盖当前所有数据。`)) return

    // 导入顺序：先清空，再按依赖顺序写入
    for (const name of ['meetings', 'transcripts', 'notes', 'summaries', 'templates', 'todos', 'tags', 'tagBindings', 'chatMessages', 'kv', 'queueJobs'] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = (db as any)[name]
      if (!t || typeof t.clear !== 'function') continue
      await t.clear()
    }
    for (const name of ['meetings', 'transcripts', 'notes', 'summaries', 'templates', 'todos', 'tags', 'tagBindings', 'chatMessages', 'kv', 'queueJobs'] as const) {
      const rows = data.tables[name]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = (db as any)[name]
      if (!t || !Array.isArray(rows) || rows.length === 0) continue
      await t.bulkPut(rows)
    }
    onImported()
    setTimeout(() => location.reload(), 600)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    window.alert('导入失败：' + msg)
  }
}