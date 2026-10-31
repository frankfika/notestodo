import { useLiveQuery } from 'dexie-react-hooks'
import { PREF_KEY as CAPTION_PREF_KEY } from '../../lib/liveCaption'
import { dataFlow, isLoopbackUrl } from '../../lib/dataFlow'
import { useEffect, useRef, useState } from 'react'
import { db } from '../../db/db'
import { DEFAULT_SETTINGS, type AiMode, type AppSettings } from '../../types'
import { DiarizationRow, EngineChooser, ModelPicker, useMissingBuiltin, missingNames } from '../../components/BuiltinModels'
import { SOURCE_LABELS, builtinAvailable, downloadModel, fmtGB, inMainlandChina, modelState, useBuiltinModels } from '../../lib/builtinModels'
import { getSettings, saveSettings } from '../../db/settings'
import { applyTheme } from '../../state/ui'
import { clearCalendarCache, fetchCalendar, getCalendarCacheMeta } from '../../calendar/ics'
import { exportData, importData } from '../../data/io'
import { exportMarkdownVault } from '../../data/mdExport'
import { ensurePersistentStorage, fmtBytes, type StorageStatus } from '../../lib/storage'
import { testLLMConnection, testASRConnection, type TestResult } from '../../llm/test-connection'
import FieldRow from '../../components/FieldRow'
import { useUI } from '../../state/ui'
import { isTauri } from '../../lib/tauri'
import { invoke } from '../../lib/tauriInvoke'
import { setApiEnabled } from '../../api/localApi'
import { systemAudioStatus, type SystemAudioStatus } from '../../lib/tauriSystemAudio'
import { reindexKnowledge } from '../../lib/knowledge'
import { importGithubIssues } from '../../lib/github'
import { importFeishuEvents } from '../../lib/feishu'

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

  // 引擎选择立即生效：只持久化两个 mode，不动页面上其它未保存的修改
  async function pickEngine(mode: AiMode): Promise<void> {
    setSettings((cur) => ({ ...cur, ai_mode: mode, asr_mode: mode }))
    await saveSettings({ ai_mode: mode, asr_mode: mode })
    flash(mode === 'builtin' ? '已切到本机内置模型' : mode === 'cloud' ? '已切到云端 API' : '已切到自建本地服务')
  }

  // 开放 API 立即生效：只持久化 api_* 字段，不动页面上其它未保存的修改
  async function applyApi(p: Partial<Pick<AppSettings, 'api_enabled' | 'api_port' | 'api_token'>>): Promise<void> {
    setSettings((cur) => ({ ...cur, ...p }))
    await saveSettings(p)
  }

  // 内置模型的选择也立即生效（下载状态是全局的，跟「保存」无关）
  async function pickBuiltin(p: Partial<Pick<AppSettings, 'builtin_asr_model' | 'builtin_llm_model'>>): Promise<void> {
    setSettings((cur) => ({ ...cur, ...p }))
    await saveSettings(p)
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
          <button onClick={() => useUI.getState().goTemplates()} className="btn-outline text-sm h-9 px-3 ml-auto mr-2">纪要模板 →</button>
          <button
            onClick={() => void save()}
            disabled={!dirty}
            className="btn-primary text-sm h-9 px-4"
          >保存修改</button>
        </div>

        <Section title="AI 运行在哪里" desc="决定录音转录和笔记 / 待办 / 对话由谁来做。选择立即生效。">
          <EngineChooser settings={settings} onPick={(m) => void pickEngine(m)} />
          {(settings.ai_mode === 'builtin' || settings.asr_mode === 'builtin') && (
            <>
              <BuiltinQuickStart settings={settings} />
              <FieldRow label="模型下载源">
                <select
                  className="input"
                  aria-label="模型下载源"
                  value={settings.model_source}
                  onChange={(e) => {
                    const v = e.target.value as AppSettings['model_source']
                    setSettings((cur) => ({ ...cur, model_source: v }))
                    void saveSettings({ model_source: v })
                  }}
                >
                  {(Object.keys(SOURCE_LABELS) as AppSettings['model_source'][]).map((k) => (
                    <option key={k} value={k}>{SOURCE_LABELS[k]}</option>
                  ))}
                </select>
                <p className="text-[11px] text-text-3 mt-1">
                  {settings.model_source === 'auto'
                    ? `已按${inMainlandChina() ? '国内' : '海外'}网络排序：${inMainlandChina() ? 'OpenCSG → hf-mirror → Hugging Face' : 'Hugging Face → hf-mirror → OpenCSG'}；一个源失败自动换下一个，断点续传。`
                    : '首选这个源，失败时自动换其它源。'}
                </p>
              </FieldRow>
            </>
          )}
        </Section>

        <DataFlowCard settings={settings} />

        <Section title="笔记模型 · LLM" desc="笔记 / 待办提取 / 对话都走它。切换不会清空另一侧已填的字段。">
          <FieldRow label="模式">
            <ModeSegmented
              value={settings.ai_mode}
              onChange={(v) => patch({ ai_mode: v })}
              labels={{
                cloud: '云端 API',
                cloudSub: 'MiniMax / Anthropic / OpenAI 兼容网关',
                local: '自建服务',
                localSub: 'Ollama / LM Studio / MLX / 自建',
              }}
            />
          </FieldRow>

          {settings.ai_mode === 'builtin' ? (
            <ModelPicker kind="llm" selected={settings.builtin_llm_model} onSelect={(id) => void pickBuiltin({ builtin_llm_model: id })} />
          ) : settings.ai_mode === 'cloud' ? (
            <>
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
            </>
          ) : (
            <LocalLLMFields settings={settings} patch={patch} />
          )}
          {settings.ai_mode !== 'builtin' && <ConnectionTestRow kind="llm" settings={settings} dirty={dirty} />}
        </Section>

        <Section title="语音转录 · ASR" desc="决定录音结束后的转录引擎。可与上面的笔记模型分开选。">
          <FieldRow label="常用人名 / 术语">
            <textarea
              className="input text-sm"
              rows={2}
              aria-label="常用人名 / 术语"
              value={settings.hotwords}
              onChange={(e) => patch({ hotwords: e.target.value })}
              placeholder="张三、李四、PoC、OKR、飞书…（逗号 / 顿号 / 换行分隔）"
            />
            <p className="text-[11px] text-text-3 mt-1">转录时当作热词，人名和专有名词更准。待办里出现过的负责人、本场速记里的短词会自动加入。</p>
          </FieldRow>
          <FieldRow label="模式">
            <ModeSegmented
              value={settings.asr_mode}
              onChange={(v) => patch({ asr_mode: v })}
              labels={{
                cloud: '云端 API',
                cloudSub: 'MiniMax / Deepgram / OpenAI Whisper 兼容网关',
                local: '自建服务',
                localSub: 'whisper.cpp server / MLX STT / faster-whisper',
              }}
            />
          </FieldRow>

          {settings.asr_mode === 'builtin' ? (
            <>
              <ModelPicker kind="asr" selected={settings.builtin_asr_model} onSelect={(id) => void pickBuiltin({ builtin_asr_model: id })} />
              <DiarizationRow />
            </>
          ) : settings.asr_mode === 'cloud' ? (
            <>
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
            </>
          ) : (
            <LocalASRFields settings={settings} patch={patch} />
          )}
          {settings.asr_mode === 'local' && (
            <div className="text-[11px] text-text-3 leading-relaxed -mt-1">
              Local 模式实际走 <code className="font-mono">POST &#123;base&#125;/audio/transcriptions</code>，
              与 <code className="font-mono">openai-whisper</code> 字段一致；
              Cloud 那一侧（MiniMax / Deepgram）的字段已保留，切换回 Cloud 即可使用。
            </div>
          )}
          {settings.asr_mode !== 'builtin' && <ConnectionTestRow kind="asr" settings={settings} dirty={dirty} />}
        </Section>

        <Section title="隐私" desc="音频归属与外观。">
          {settings.asr_mode === 'cloud' && (
            <Toggle
              checked={settings.delete_remote_audio}
              onChange={(v) => patch({ delete_remote_audio: v })}
              label="转录后删除云端音频"
              hint="关掉则会保留在供应商的存储里——通常不要。"
            />
          )}
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

        <Section
          title="知识库 · Knowledge"
          desc="把本地笔记 / markdown 文本喂给 Live Assist，会议中按速记 / 转录自动推荐相关卡片。当前 MVP 用 keyword + 标题匹配；embedding 升级见 README。"
        >
          <KnowledgeFolderEditor
            folders={settings.knowledge_folders}
            onChange={(folders) => patch({ knowledge_folders: folders })}
            onFlash={flash}
          />
        </Section>

        <Section title="日历" desc="订阅任意 .ics URL（Apple iCloud / Google / QQ 邮箱 / Outlook / 飞书日历「订阅链接」/ 腾讯会议日历订阅链接都行），仅本地拉取。">
          <IcsListEditor
            urls={settings.calendar_ics_urls}
            onChange={(urls) => patch({ calendar_ics_urls: urls })}
            onFlash={flash}
          />
        </Section>

        <Section title="GitHub" desc="把某个仓库的 open issues 导入为任务（按 issue 链接去重，重复导入不会翻倍）。">
          <FieldRow label="仓库">
            <input
              className="input font-mono"
              value={settings.github_repo}
              onChange={(e) => patch({ github_repo: e.target.value })}
              placeholder="owner/name"
            />
          </FieldRow>
          <FieldRow label="Token" hint="私有仓库需要；公开仓库可留空">
            <PasswordInput
              value={settings.github_token}
              onChange={(v) => patch({ github_token: v })}
              placeholder="ghp_...（可留空）"
            />
          </FieldRow>
          <ImportButton
            label="导入 issues"
            disabled={dirty}
            run={() => importGithubIssues(settings, db)}
            onFlash={flash}
          />
        </Section>

        <Section title="飞书" desc="用自建应用的 App ID / Secret 拉主日历未来 7 天日程，生成会议壳（无音频），按日程 ID 去重。">
          <FieldRow label="App ID">
            <input
              className="input font-mono"
              value={settings.feishu_app_id}
              onChange={(e) => patch({ feishu_app_id: e.target.value })}
              placeholder="cli_..."
            />
          </FieldRow>
          <FieldRow label="App Secret">
            <PasswordInput
              value={settings.feishu_app_secret}
              onChange={(v) => patch({ feishu_app_secret: v })}
            />
          </FieldRow>
          <ImportButton
            label="导入日程"
            disabled={dirty}
            run={() => importFeishuEvents(settings, db)}
            onFlash={flash}
          />
        </Section>

        <Section title="开放 API" desc="桌面版本机起 HTTP 服务（127.0.0.1），让 Raycast / 快捷指令 / 脚本读写任务和笔记。改动立即生效。">
          <OpenApiRow settings={settings} onApply={(p) => void applyApi(p)} flash={flash} />
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
 * Cloud BYOK | Local 双选控件（与 toggle 视觉一致：底部高亮横条）。
 * 切换时保留另一侧的 settings 字段（已通过 KV 整体 patch 实现，UI 不动）。
 *
 * Phase-3: 同时给 LLM 和 ASR 用；通过 `labels` 传话术。两条目均为 'cloud' | 'local'。
 */
function ModeSegmented({
  value,
  onChange,
  labels,
}: {
  value: AiMode
  onChange: (v: AiMode) => void
  labels: { cloud: string; cloudSub: string; local: string; localSub: string }
}): JSX.Element {
  const opts: { v: AiMode; label: string; sub: string; disabled?: boolean }[] = [
    { v: 'builtin', label: '本机内置', sub: builtinAvailable() ? '应用内置模型，完全离线' : '需要 macOS 桌面版', disabled: !builtinAvailable() },
    { v: 'cloud', label: labels.cloud, sub: labels.cloudSub },
    { v: 'local', label: labels.local, sub: labels.localSub },
  ]
  return (
    <div className="inline-flex rounded-[10px] border border-line bg-bg-overlay p-0.5 gap-0.5">
      {opts.map((o) => {
        const active = o.v === value
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            disabled={o.disabled}
            className={`px-3 py-1.5 rounded-[8px] text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              active ? 'bg-bg-raise text-text-1 shadow-sm' : 'text-text-3 hover:text-text-1'
            }`}
            title={o.sub}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Local ASR 配置：whisper.cpp / MLX / faster-whisper OpenAI 兼容端点。
 * whisper.cpp server 默认 `http://127.0.0.1:8080/v1`；Custom 给 MLX STT /
 * 自建 OpenAI 兼容服务。API Key 留空即可（whisper.cpp 默认无鉴权）。
 */
function LocalASRFields({
  settings,
  patch,
}: {
  settings: AppSettings
  patch: (p: Partial<AppSettings>) => void
}): JSX.Element {
  const isWhisperPreset = settings.local_asr_base_url === 'http://127.0.0.1:8080/v1'
  function pickPreset(p: 'whisper' | 'custom'): void {
    if (p === 'whisper') {
      patch({ local_asr_base_url: 'http://127.0.0.1:8080/v1' })
    } else {
      if (isWhisperPreset) patch({ local_asr_base_url: '' })
    }
  }
  return (
    <>
      <FieldRow label="预设">
        <div className="inline-flex rounded-[10px] border border-line bg-bg-overlay p-0.5 gap-0.5">
          <button
            type="button"
            onClick={() => pickPreset('whisper')}
            className={`px-3 py-1.5 rounded-[8px] text-sm ${
              isWhisperPreset ? 'bg-bg-raise text-text-1 shadow-sm' : 'text-text-3 hover:text-text-1'
            }`}
          >whisper.cpp</button>
          <button
            type="button"
            onClick={() => pickPreset('custom')}
            className={`px-3 py-1.5 rounded-[8px] text-sm ${
              !isWhisperPreset ? 'bg-bg-raise text-text-1 shadow-sm' : 'text-text-3 hover:text-text-1'
            }`}
          >Custom</button>
        </div>
      </FieldRow>
      <FieldRow label="Base URL" hint="OpenAI 兼容端点（/v1/audio/transcriptions）">
        <input
          className="input font-mono"
          value={settings.local_asr_base_url}
          onChange={(e) => patch({ local_asr_base_url: e.target.value })}
          placeholder="http://127.0.0.1:8080/v1"
        />
        {settings.local_asr_base_url && !isLoopbackUrl(settings.local_asr_base_url) && (
          <div className="text-[11px] text-warning mt-1">这不是本机地址，会议内容会发到 {settings.local_asr_base_url}，不算「本地」。</div>
        )}
      </FieldRow>
      <FieldRow label="API Key" hint="留空即可（whisper.cpp 默认无鉴权）">
        <PasswordInput
          value={settings.local_asr_api_key}
          onChange={(v) => patch({ local_asr_api_key: v })}
          placeholder="（可选）"
        />
      </FieldRow>
      <FieldRow label="Model" hint="如 whisper-1 / large-v3-turbo，或服务端的 model 名称">
        <input
          className="input font-mono"
          value={settings.local_asr_model}
          onChange={(e) => patch({ local_asr_model: e.target.value })}
          placeholder="whisper-1"
        />
      </FieldRow>
      <div className="text-[11px] text-text-3 leading-relaxed -mt-1">
        whisper.cpp：<code className="font-mono">whisper-server -m models/ggml-large-v3.bin --port 8080</code>
        （或 <code className="font-mono">./server -m ...</code>）；MLX STT /
        faster-whisper openai-compatible server 也走同一 Base URL。
      </div>
    </>
  )
}

/**
 * Local LLM 配置：Base URL（带 Ollama 预设）+ 可选 API Key + Model。
 * Ollama 默认 `ollama serve` 后用 http://127.0.0.1:11434/v1 即可；Custom 给 LM Studio / MLX 等。
 */
function LocalLLMFields({
  settings,
  patch,
}: {
  settings: AppSettings
  patch: (p: Partial<AppSettings>) => void
}): JSX.Element {
  const isOllamaPreset = settings.local_llm_base_url === 'http://127.0.0.1:11434/v1'
  function pickPreset(p: 'ollama' | 'custom'): void {
    if (p === 'ollama') {
      patch({ local_llm_base_url: 'http://127.0.0.1:11434/v1' })
    } else {
      // 不重置，让用户继续编辑；但若当前是 ollama 默认值则清空让用户输入
      if (isOllamaPreset) patch({ local_llm_base_url: '' })
    }
  }
  return (
    <>
      <FieldRow label="预设">
        <div className="inline-flex rounded-[10px] border border-line bg-bg-overlay p-0.5 gap-0.5">
          <button
            type="button"
            onClick={() => pickPreset('ollama')}
            className={`px-3 py-1.5 rounded-[8px] text-sm ${
              isOllamaPreset ? 'bg-bg-raise text-text-1 shadow-sm' : 'text-text-3 hover:text-text-1'
            }`}
          >Ollama</button>
          <button
            type="button"
            onClick={() => pickPreset('custom')}
            className={`px-3 py-1.5 rounded-[8px] text-sm ${
              !isOllamaPreset ? 'bg-bg-raise text-text-1 shadow-sm' : 'text-text-3 hover:text-text-1'
            }`}
          >Custom</button>
        </div>
      </FieldRow>
      <FieldRow label="Base URL" hint="OpenAI 兼容端点（/v1/chat/completions）">
        <input
          className="input font-mono"
          value={settings.local_llm_base_url}
          onChange={(e) => patch({ local_llm_base_url: e.target.value })}
          placeholder="http://127.0.0.1:11434/v1"
        />
        {settings.local_llm_base_url && !isLoopbackUrl(settings.local_llm_base_url) && (
          <div className="text-[11px] text-warning mt-1">这不是本机地址，会议内容会发到 {settings.local_llm_base_url}，不算「本地」。</div>
        )}
      </FieldRow>
      <FieldRow label="API Key" hint="留空即可（Ollama 默认无鉴权）">
        <PasswordInput
          value={settings.local_llm_api_key}
          onChange={(v) => patch({ local_llm_api_key: v })}
          placeholder="（可选）"
        />
      </FieldRow>
      <FieldRow label="Model" hint="如 llama3.2 / qwen2.5 / mistral 等">
        <input
          className="input font-mono"
          value={settings.local_llm_model}
          onChange={(e) => patch({ local_llm_model: e.target.value })}
          placeholder="llama3.2"
        />
      </FieldRow>
      <div className="text-[11px] text-text-3 leading-relaxed -mt-1">
        Ollama: 先 <code className="font-mono">ollama serve</code>；若模型放在外置盘（如 UGREEN），
        在启动前 <code className="font-mono">export OLLAMA_MODELS=/Volumes/UGREEN/ollama</code>。
        Custom: LM Studio / MLX / 自建 OpenAI 兼容服务都可填 Base URL。
      </div>
    </>
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

/** 导入按钮：跑 run() 并报「导入了 N 条，跳过 M 条」。dirty 时置灰（未保存的 token/repo 还没落库）。 */
function ImportButton({ label, disabled, run, onFlash }: {
  label: string
  disabled?: boolean
  run: () => Promise<{ imported: number; skipped: number }>
  onFlash: (msg: string) => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  async function go(): Promise<void> {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const r = await run()
      setResult(`导入了 ${r.imported} 条，跳过 ${r.skipped} 条`)
      onFlash(`${label}完成`)
    } catch (e: unknown) {
      setResult('失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-2 pt-1">
      <button
        onClick={() => void go()}
        disabled={busy || disabled}
        className="btn-outline text-xs h-8 px-3"
        title={disabled ? '有未保存的修改 — 先保存再导入' : undefined}
      >
        {busy ? '导入中…' : label}
      </button>
      {result && <span className="text-xs text-text-2">{result}</span>}
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
      // Phase-2: fetchCalendar 不依赖 ai_mode / local_llm_*，只取 calendar_ics_urls；
      // 用 DEFAULT_SETTINGS 兜底其它字段（避免 spread 漏掉新增字段）。
      const r = await fetchCalendar({
        ...DEFAULT_SETTINGS,
        calendar_ics_urls: urls,
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

  async function doMarkdownExport(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const r = await exportMarkdownVault()
      setLastMsg(`已导出 ${r.fileCount} 个 .md 文件（${(r.sizeBytes / 1024).toFixed(0)} KB）— 笔记是带 frontmatter 的纯文本，可直接当 Obsidian vault 打开`)
      flash('Markdown 导出完成')
    } catch (e: unknown) {
      setLastMsg('Markdown 导出失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
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
        <button onClick={() => void doMarkdownExport()} disabled={busy} className="btn-outline text-sm h-9">
          导出 Markdown
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

/** 开放 API：开关 / 端口 / token。改动立即启停本机 HTTP 服务（api/localApi.ts）。 */
function OpenApiRow({ settings, onApply, flash }: {
  settings: AppSettings
  onApply: (p: Partial<Pick<AppSettings, 'api_enabled' | 'api_port' | 'api_token'>>) => void
  flash: (msg: string) => void
}): JSX.Element {
  const [err, setErr] = useState<string | null>(null)
  const tauri = isTauri()
  const port = settings.api_port || 17893
  const token = settings.api_token
  const base = `http://127.0.0.1:${port}`

  async function restartWith(p: Partial<Pick<AppSettings, 'api_enabled' | 'api_port' | 'api_token'>>): Promise<void> {
    setErr(null)
    onApply(p)
    const enabled = p.api_enabled ?? settings.api_enabled
    try {
      await setApiEnabled(enabled, p.api_port ?? port, p.api_token ?? token)
      if (enabled) flash('开放 API 已开启')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  function regenerate(): void {
    const t = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
    void restartWith({ api_token: t }).then(() => flash('已生成新 token'))
  }

  if (!tauri) {
    return <div className="text-[12px] text-text-3">开放 API 仅桌面版（mac app）可用——浏览器页面没有宿主能监听本机端口。</div>
  }
  return (
    <div className="space-y-2">
      <Toggle
        checked={settings.api_enabled}
        onChange={(v) => void restartWith({ api_enabled: v })}
        label="启用本机 HTTP 服务"
        hint={`${base} — 只有本机程序能访问；所有写接口（除 /health）都要 Bearer token。`}
      />
      <FieldRow label="端口">
        <input
          className="input h-8 w-28"
          type="number"
          min={1024}
          max={65535}
          value={port}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (v >= 1024 && v <= 65535) void restartWith({ api_port: v })
          }}
        />
      </FieldRow>
      <FieldRow label="API token">
        <div className="flex items-center gap-2">
          <code className="text-[11px] text-text-2 bg-bg-overlay border border-line rounded px-2 py-1">
            {token ? `${token.slice(0, 8)}…${token.slice(-4)}` : '（启用时自动生成）'}
          </code>
          <button onClick={regenerate} className="btn-ghost text-xs h-7 px-2">重新生成</button>
          {token && (
            <button
              onClick={() => { void navigator.clipboard.writeText(token).then(() => flash('token 已复制')) }}
              className="btn-ghost text-xs h-7 px-2"
            >复制</button>
          )}
        </div>
      </FieldRow>
      <div className="text-[11px] text-text-3 space-y-0.5">
        <div>示例：<code className="text-text-2">curl -H "Authorization: Bearer &lt;token&gt;" {base}/todos</code></div>
        <div>任务：<code className="text-text-2">GET/POST /todos · PATCH/DELETE /todos/:id</code>（DELETE 软删整棵子树）｜笔记：<code className="text-text-2">GET/POST /notes · GET /notes/:id</code></div>
      </div>
      {err && <div className="text-[12px] text-danger">{err}</div>}
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
        : '麦克风 + 系统声音（需在 macOS 「系统设置 → 隐私与安全性 → 屏幕录制」中允许「拾贝」，点右侧「授权向导」一键完成）'
      : '仅麦克风（当前平台不支持系统音频采集）'
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
        {inTauri && (
          <button
            type="button"
            onClick={() => useUI.getState().setPermGuideOpen(true)}
            className="btn-primary text-xs h-7"
          >授权向导</button>
        )}
      </div>
      <div className="text-[11px] text-text-3 leading-relaxed">
        {inTauri
          ? 'NotesToGO 桌面版通过 macOS ScreenCaptureKit 采集会议播放声（系统音频 loopback）。首次启用 macOS 会弹窗要求屏录权限；未授权时点「授权向导」即可一键授权、直达设置页并重启生效。'
          : '浏览器无法直接拿到系统声音（DRM / 平台限制）。要录到 Zoom/Meet 播放声，请用 NotesToGO macOS 桌面版。'}
      </div>
    </div>
  )
}

/**
 * 知识库文件夹列表 + 重新索引按钮。
 *
 * Phase-3: Tauri 端用 `tauri-plugin-dialog` 弹出系统文件夹选择器，自动获得
 * 用户授权的本地路径；本地路径走 `tauri-plugin-fs` 递归 walk（见
 * `lib/knowledge.ts → listLocalFiles`）。Web build 仍允许粘贴路径或 HTTP(S) URL。
 */
function KnowledgeFolderEditor({
  folders, onChange, onFlash,
}: {
  folders: string[]
  onChange: (f: string[]) => void
  onFlash: (msg: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastReindex, setLastReindex] = useState<{ scanned: number; indexed: number; errors: string[] } | null>(null)

  async function reindex(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const r = await reindexKnowledge(folders)
      setLastReindex({ scanned: r.scanned, indexed: r.indexed, errors: r.errors })
      if (r.errors.length > 0) {
        onFlash(`索引完成：${r.indexed} 条 / ${r.scanned} 个文件（${r.errors.length} 个错误）`)
      } else {
        onFlash(`索引完成：${r.indexed} 条 / ${r.scanned} 个文件`)
      }
    } catch (e: unknown) {
      onFlash('索引失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 在 Tauri 端调用 `plugin:dialog|open` 拿系统级目录选择器；返回 string|null。
   * 多选会拿到 string[]，这里仅单选。
   */
  async function pickTauriFolder(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const picked = await invoke<string | null>('plugin:dialog|open', {
        options: { directory: true, multiple: false, title: '选择知识库文件夹' },
      })
      if (!picked) return
      const list = Array.isArray(picked) ? picked : [picked]
      const next = folders.concat(list.filter((p) => p && !folders.includes(p)))
      onChange(next)
    } catch (e: unknown) {
      onFlash('文件夹选择失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {folders.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <input className="input font-mono text-xs" value={p} readOnly />
          <button
            type="button"
            onClick={() => onChange(folders.filter((_, idx) => idx !== i))}
            className="icon-btn"
            aria-label="移除"
            title="删除"
          >✕</button>
        </div>
      ))}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          className="input font-mono text-xs flex-1 min-w-[200px]"
          placeholder={isTauri()
            ? '可粘贴本地路径；或点右侧按钮打开系统文件夹选择器'
            : 'https://example.com/notes.md  或本地路径（仅 Tauri 桌面版有效）'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            if (draft.trim()) {
              onChange([...folders, draft.trim()])
              setDraft('')
            }
          }}
          className="btn-outline text-sm h-9"
        >+ 添加</button>
        {isTauri() && (
          <button
            type="button"
            onClick={() => void pickTauriFolder()}
            disabled={busy}
            className="btn-outline text-sm h-9"
            title="打开系统文件夹选择器"
          >📁 选文件夹</button>
        )}
        <button
          type="button"
          onClick={() => void reindex()}
          disabled={busy || folders.length === 0}
          className="btn-outline text-sm h-9"
        >{busy ? '索引中…' : '↻ 重新索引'}</button>
      </div>
      {lastReindex && (
        <div className="text-[11px] text-text-3">
          上次索引：{lastReindex.indexed} 条 / {lastReindex.scanned} 文件
          {lastReindex.errors.length > 0 && ` · ${lastReindex.errors.length} 错误`}
        </div>
      )}
      <div className="text-[11px] text-text-3 leading-relaxed">
        MVP 用 keyword + 标题匹配（bigram Jaccard + CJK 2-gram），无需联网；
        升级路径：on-device embedding（EmbeddingGemma-class）+ chunked 索引，
        <code className="font-mono">retrieveKnowledge()</code> API 保持不变 → 调用方零改动。
        {isTauri()
          ? '桌面版递归 walk .md / .txt；浏览器里只能读 HTTP(S) URL。'
          : '桌面版可用 tauri-plugin-fs 递归 walk 本地文件夹。'}
      </div>
    </div>
  )
}
// ── 数据去向（合规自检）────────────────────────────────────────────
// 实时反映当前（含未保存）配置：会议内容会被送到哪里。只有回环地址算「本机」。
function DataFlowCard({ settings }: { settings: AppSettings }): JSX.Element {
  const captionsOn = useLiveQuery(async () => (await db.kv.get(CAPTION_PREF_KEY))?.value === true, []) ?? false
  const flow = dataFlow(settings, captionsOn)
  const leaks = flow.filter((f) => f.where === 'remote')
  return (
    <section className={`card p-4 mb-6 ${leaks.length === 0 ? 'border-accent/30' : 'border-warning/40'}`} aria-label="数据去向">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold text-text-1">数据去向</h2>
        <span className={`text-[11px] px-2 py-0.5 rounded-full ${leaks.length === 0 ? 'bg-accent/10 text-accent' : 'bg-warning/10 text-warning'}`}>
          {leaks.length === 0 ? '✓ 会议内容全部留在本机' : `⚠ ${leaks.length} 项会离开本机`}
        </span>
      </div>
      <ul className="text-[12.5px] space-y-1">
        {flow.map((f) => (
          <li key={f.what} className="flex items-center gap-2">
            <span className="text-text-2 flex-1">{f.what}</span>
            <span className={f.where === 'device' ? 'text-accent' : 'text-warning'}>{f.where === 'device' ? '本机' : `→ ${f.to}`}</span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-text-3 mt-2 leading-relaxed">
        录音、速记、笔记、待办始终只存在本机（IndexedDB）。无遥测。日历 / 知识库 / 内置模型文件（Hugging Face / hf-mirror / OpenCSG）只下载，不上传会议内容。
      </p>
    </section>
  )
}

// 选了「本机内置」但模型还没下：一键下载当前选中的转录 + 笔记模型
function BuiltinQuickStart({ settings }: { settings: AppSettings }): JSX.Element | null {
  const missing = useMissingBuiltin(settings)
  useBuiltinModels((s) => s.models) // 订阅进度
  if (missing.length === 0) {
    return <p className="text-[12px] text-accent">✓ 本地模型已就绪，可以离线使用。</p>
  }
  const total = missing.reduce((a, m) => a + m.bytes, 0)
  const downloading = missing.map((m) => modelState(m.id)).filter((x) => x.state === 'downloading')
  if (downloading.length > 0) {
    const got = downloading.reduce((a, x) => a + (x.state === 'downloading' ? x.received : 0), 0)
    return (
      <p className="text-[12px] text-text-2">
        正在下载 {missingNames(missing)} · {fmtGB(got)} / {fmtGB(total)}（可离开此页，后台继续；期间可以照常录音）
      </p>
    )
  }
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3 flex flex-wrap items-center gap-3">
      <div className="flex-1 min-w-[220px]">
        <div className="text-sm text-text-1 font-medium">还需要下载 {missingNames(missing)}</div>
        <p className="text-[11.5px] text-text-3 mt-0.5">共 {fmtGB(total)}，只需一次；国内自动走 OpenCSG / hf-mirror，只下载、不上传任何内容。下载期间可以照常录音，下好后会自动整理。</p>
      </div>
      <button type="button" onClick={() => missing.forEach((m) => void downloadModel(m.id))} className="btn-primary text-xs h-8 px-3">
        下载（{fmtGB(total)}）
      </button>
    </div>
  )
}
