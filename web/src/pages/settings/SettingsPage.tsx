import { useEffect, useRef, useState } from 'react'
import { db } from '../../db/db'
import { DEFAULT_SETTINGS, type AppSettings } from '../../types'
import { getSettings, saveSettings } from '../../db/settings'
import { applyTheme } from '../../state/ui'
import { clearCalendarCache, fetchCalendar, getCalendarCacheMeta } from '../../calendar/ics'
import { exportData, importData } from '../../data/io'
import { ensurePersistentStorage, fmtBytes, type StorageStatus } from '../../lib/storage'
import { testLLMConnection, testASRConnection, type TestResult } from '../../llm/test-connection'
import FieldRow from '../../components/FieldRow'
import { isTauri } from '../../lib/tauri'
import { systemAudioStatus, type SystemAudioStatus } from '../../lib/tauriSystemAudio'

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
    setSettings((cur) => {
      const next = { ...cur, ...p }
      // 主题立即生效（不等保存）：applyTheme 直接调 document classList
      if (p.theme && p.theme !== cur.theme) {
        const resolved = p.theme === 'system'
          ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : p.theme
        applyTheme(resolved as 'dark' | 'light')
      }
      return next
    })
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
          <ConnectionTestRow kind="llm" settings={settings} dirty={dirty} />
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
          <ConnectionTestRow kind="asr" settings={settings} dirty={dirty} />
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

        <Section title="录音采集 · Capture" desc="决定录音能拿到什么声音。">
          <CaptureStatusRow />
        </Section>

        <Section title="日历" desc="订阅任意 .ics URL（Apple iCloud / Google / QQ 邮箱 / Outlook / 飞书「导出链接」都行），仅本地拉取。">
          <IcsListEditor
            urls={settings.calendar_ics_urls}
            onChange={(urls) => patch({ calendar_ics_urls: urls })}
            onFlash={flash}
          />
        </Section>

        <Section title="数据" desc="导出 = 单个 .zip（含所有表 + 录音原文）；导入会覆盖现有全部数据。">
          <ExportImportRow flash={flash} />
          <StorageStatusRow />
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

/**
 * 连接测试：BYOK 的信任闭环 — 填完 key 立刻验证，而不是等第一场会议失败。
 * dirty 时置灰（当前未保存的草稿不代表将保存的配置）。
 */
function ConnectionTestRow({ kind, settings, dirty }: { kind: 'llm' | 'asr'; settings: AppSettings; dirty: boolean }): JSX.Element {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  async function run(): Promise<void> {
    if (testing) return
    setTesting(true)
    setResult(null)
    const r = kind === 'llm' ? await testLLMConnection(settings) : await testASRConnection(settings)
    setResult(r)
    setTesting(false)
  }

  return (
    <div className="flex items-center gap-2 pt-1">
      <button
        onClick={() => void run()}
        disabled={testing || dirty}
        className="btn-outline text-xs h-8 px-3"
        title={dirty ? '有未保存的修改 — 先保存再测试' : undefined}
      >
        {testing ? '测试中…' : '测试连接'}
      </button>
      {result && (
        <span className={`text-xs ${result.ok ? 'text-accent' : 'text-danger'}`}>
          {result.ok ? '✓ ' : '✕ '}{result.message}
        </span>
      )}
    </div>
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

function IcsListEditor({
  urls, onChange, onFlash,
}: {
  urls: string[]
  onChange: (urls: string[]) => void
  onFlash: (msg: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [meta, setMeta] = useState<{ fetchedAt: number | null; count: number }>({ fetchedAt: null, count: 0 })

  useEffect(() => {
    void getCalendarCacheMeta().then(setMeta)
  }, [urls])

  async function syncNow(): Promise<void> {
    if (syncing) return
    setSyncing(true)
    try {
      await clearCalendarCache()
      const r = await fetchCalendar({
        ...DEFAULT_SETTINGS,
        calendar_ics_urls: urls,
        llm_provider: 'anthropic-compatible',
        llm_base_url: '',
        llm_api_key: '',
        llm_model: '',
        asr_provider: 'minimax',
        asr_base_url: '',
        asr_api_key: '',
        asr_model: '',
        delete_remote_audio: true,
        theme: 'light',
      })
      if (r.error) {
        onFlash(`部分失败：${r.error.slice(0, 60)}`)
      } else {
        onFlash(`已同步 ${r.events.length} 个事件`)
      }
      setMeta(await getCalendarCacheMeta())
    } catch (e: unknown) {
      onFlash('同步失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-3">
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
            placeholder="https://calendar.example.com/abc.ics（或 webcal://）"
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
          <button
            type="button"
            onClick={() => void syncNow()}
            disabled={urls.length === 0 || syncing}
            className="btn-outline text-sm h-9"
          >{syncing ? '同步中…' : '↻ 立即同步'}</button>
        </div>
        <div className="text-[11px] text-text-3">
          {meta.fetchedAt
            ? `上次同步：${new Date(meta.fetchedAt).toLocaleString('zh-CN')} · ${meta.count} 个事件 · 缓存 15 分钟自动刷新`
            : '尚未同步'}
          {' · 拉到的事件仅本机使用（local-first）'}
        </div>
    </div>
  )
}

function ExportImportRow({ flash }: { flash: (msg: string) => void }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [lastMsg, setLastMsg] = useState<string | null>(null)

  async function doExport(): Promise<void> {
    if (busy) return
    setBusy(true)
    setLastMsg('正在打包…')
    try {
      const r = await exportData((p) => setLastMsg(p.message))
      setLastMsg(`已导出 ${r.filename}（${(r.sizeBytes / 1024).toFixed(0)} KB · ${r.manifest.table_counts.audioChunks} 段音频）`)
      flash(`已导出 ${r.manifest.table_counts.audioChunks} 段音频`)
    } catch (e: unknown) {
      setLastMsg('导出失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  async function doImport(file: File): Promise<void> {
    if (busy) return
    if (!window.confirm(`导入会覆盖当前所有数据，确认？`)) return
    setBusy(true)
    setLastMsg('正在解压并写入…')
    try {
      const r = await importData(file, (p) => setLastMsg(p.message))
      setLastMsg(`已恢复 ${r.audioCount} 段音频（${r.manifest.table_counts.meetings} 场会议）`)
      flash('导入完成 — 即将重载')
      setTimeout(() => location.reload(), 1200)
    } catch (e: unknown) {
      setLastMsg('导入失败：' + (e instanceof Error ? e.message : String(e)))
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={() => void doExport()} disabled={busy} className="btn-outline text-sm h-9">
          {busy ? '处理中…' : '导出 .zip'}
        </button>
        <button onClick={() => ref.current?.click()} disabled={busy} className="btn-outline text-sm h-9">
          导入 .zip
        </button>
        <input
          ref={ref}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            void doImport(f)
            e.target.value = ''
          }}
        />
      </div>
      {lastMsg && (
        <div className="text-[11px] text-text-3">{lastMsg}</div>
      )}
    </div>
  )
}

/**
 * 本地存储状态：持久化是否获批 + 已用/配额。
 * 持久化被浏览器拒绝时给出可操作的提示（数据安全是本产品的核心承诺）。
 */
function StorageStatusRow(): JSX.Element {
  const [status, setStatus] = useState<StorageStatus | null>(null)
  useEffect(() => {
    void ensurePersistentStorage().then(setStatus)
  }, [])
  if (!status) return <div className="text-[11px] text-text-3">读取存储状态…</div>
  const pct = status.quota && status.usage != null ? Math.round((status.usage / status.quota) * 100) : null
  return (
    <div className="flex items-center gap-2 text-[11px] text-text-3">
      <span className={status.persisted ? 'text-accent' : 'text-danger'}>●</span>
      <span>
        本地存储{status.persisted ? '已持久化' : status.supported ? '未持久化' : '不支持持久化标记'}
        {status.usage != null && status.quota != null && (
          <> · 已用 {fmtBytes(status.usage)}{pct != null ? `（${pct}%）` : ''}</>
        )}
        {!status.persisted && status.supported && (
          <span className="text-text-3"> — 建议导出 .zip 备份，浏览器可能在磁盘压力下清理数据</span>
        )}
      </span>
    </div>
  )
}

/**
 * 当前录音采集模式 + 系统音频支持状态。
 *
 * 永远显示真值（不假装）：
 *   - 浏览器：仅麦克风
 *   - Tauri + screencapturekit 已实装：麦克风 + 系统声音（屏录权限需在
 *     「系统设置 → 隐私与安全性 → 屏幕录制」允许 NotesToGO）
 *   - Tauri 但未实装：仅麦克风 + 灰一行"未实装"
 */
function CaptureStatusRow(): JSX.Element {
  const [status, setStatus] = useState<SystemAudioStatus | null>(null)
  const [probing, setProbing] = useState(false)

  async function probe(): Promise<void> {
    if (probing) return
    setProbing(true)
    try {
      setStatus(await systemAudioStatus())
    } finally {
      setProbing(false)
    }
  }
  useEffect(() => {
    void probe()
  }, [])

  const inTauri = isTauri()
  const dot = status && 'supported' in status && status.supported && status.permission_granted
    ? 'text-accent'
    : 'text-warning'
  const label = inTauri
    ? status && 'supported' in status && status.supported
      ? status.permission_granted
        ? '麦克风 + 系统声音（Tauri · 屏录已授权）'
        : '麦克风 + 系统声音（需在 macOS 「系统设置 → 隐私与安全性 → 屏幕录制」中允许 NotesToGO）'
      : '仅麦克风（Tauri desktop · system-audio 未实装）'
    : '仅麦克风（浏览器）'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm text-text-1">
        <span className={dot}>●</span>
        <span>{label}</span>
        <button
          type="button"
          onClick={() => void probe()}
          disabled={probing}
          className="btn-outline text-xs h-7 ml-auto"
        >{probing ? '探测中…' : '重新探测'}</button>
      </div>
      <div className="text-[11px] text-text-3 leading-relaxed">
        {inTauri
          ? 'NotesToGO 桌面版通过 macOS ScreenCaptureKit 采集会议播放声（系统音频 loopback）。首次启用 macOS 会弹窗要求屏录权限；如被拒请到「系统设置 → 隐私与安全性 → 屏幕录制」中手动允许。'
          : '浏览器无法直接拿到系统声音（DRM / 平台限制）。要录到 Zoom/Meet 播放声，请用 NotesToGO macOS 桌面版。'}
      </div>
    </div>
  )
}