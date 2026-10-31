import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { DEFAULT_SETTINGS, type AppSettings } from '../types'
import { saveSettings } from '../db/settings'
import { useUI } from '../state/ui'
import { mod } from '../lib/id'
import { EngineChooser, useMissingBuiltin, missingNames } from './BuiltinModels'
import { downloadModel, fmtGB } from '../lib/builtinModels'
import { createPage } from '../lib/notes'

/**
 * 首次启动引导：右下角可关闭面板——始终不拦截主 UI。
 *       使用者可随手点开 / 关掉；全部 3 步完成才标记 done。
 *
 * 完成 / 关闭事件通过 db.kv['onboarding_done_v1'] 持久化，外部代码
 * （如开始录音）也可以写入它表示用户已"上手"。
 */
export default function Onboarding(): JSX.Element | null {
  const [minimized, setMinimized] = useState(false)
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<AppSettings>(DEFAULT_SETTINGS)
  const goSettings = useUI((s) => s.goSettings)
  const goNote = useUI((s) => s.goNote)
  const goMeetings = useUI((s) => s.goMeetings)
  const goTodos = useUI((s) => s.goTodos)
  // 选内置时要下的模型（已下好的不重复下）；笔记模型较大，首访只自动下转录侧
  const builtinNeed = useMissingBuiltin({ ...draft, ai_mode: 'builtin', asr_mode: 'builtin' })
  const asrNeed = builtinNeed.filter((m) => m.kind !== 'llm')
  const llmNeed = builtinNeed.filter((m) => m.kind === 'llm')

  // 通过 liveQuery 监听 onboarding_done_v1；外部写入后自动隐藏
  const onboardingRow = useLiveQuery(() => db.kv.get('onboarding_done_v1'), [])
  const done = onboardingRow?.value === true
  const open = !done

  useEffect(() => {
    void db.kv.get('settings').then((srow) => {
      if (srow?.value) setDraft({ ...DEFAULT_SETTINGS, ...(srow.value as Partial<AppSettings>) })
    })
  }, [])

  async function close(done: boolean): Promise<void> {
    if (done) await db.kv.put({ key: 'onboarding_done_v1', value: true })
    // 不需要 setOpen(false)：liveQuery 会驱动重新渲染
  }

  async function saveKeysAndNext(): Promise<void> {
    await saveSettings(draft)
    if (draft.ai_mode === 'builtin') for (const m of asrNeed) void downloadModel(m.id)
    setStep(2)
  }

  async function tryIt(where: 'meeting' | 'note' | 'todo'): Promise<void> {
    await close(true)
    if (where === 'note') goNote(await createPage())
    else if (where === 'meeting') goMeetings()
    else goTodos()
  }

  if (!open) return null

  // 气泡头状态——只剩一步
  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="fixed bottom-5 md:bottom-5 right-5 z-40 card px-4 py-3 shadow-2xl hover:border-accent/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-accent text-lg leading-none">●</span>
          <span className="text-sm text-text-1 font-medium">欢迎使用拾贝</span>
          <span className="chip text-[10px]">{step + 1}/3</span>
        </div>
      </button>
    )
  }

  return (
    <div
      className="fixed bottom-20 md:bottom-5 right-3 md:right-5 z-40 w-[420px] max-w-[calc(100vw-1.5rem)] card p-5 shadow-2xl"
      role="dialog"
    >
      {/* 顶栏 */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-accent text-base">●</span>
        <span className="section-title">拾贝 · 新用户引导</span>
        <span className="chip text-[10px]">{step + 1}/3</span>
        <button
          onClick={() => setMinimized(true)}
          className="icon-btn ml-auto"
          title="收起来（可从右下角小气泡再打开）"
          aria-label="最小化"
        >—</button>
        <button
          onClick={() => void close(true)}
          className="icon-btn"
          title="关闭引导（不再显示）"
          aria-label="关闭"
        >✕</button>
      </div>

      {/* 进度 */}
      <div className="flex items-center gap-1.5 mb-4">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i <= step ? 'bg-accent' : 'bg-bg-overlay'
            }`}
          />
        ))}
      </div>

      {step === 0 && (
        <div>
          <h3 className="text-base font-semibold text-text-1 mb-2">你的 AI 工作区</h3>
          <p className="text-xs text-text-2 leading-relaxed mb-3">
            一个地方管好三件事——所有数据存在你本机，导出 .zip 即可带走：
          </p>
          <div className="space-y-2 mb-4">
            {([
              { key: 'meeting' as const, icon: '🎙', title: '会议速记', desc: `按 ${mod()}⇧R 开录，散会自动转录、整理成笔记、提取待办` },
              { key: 'note' as const, icon: '📝', title: '笔记', desc: 'Notion 式页面与块编辑器，支持双链、标签、AI 续写' },
              { key: 'todo' as const, icon: '✅', title: '任务看板', desc: '任务树 + Trello 式看板，会议待办自动汇入' },
            ]).map((c) => (
              <div key={c.key} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
                <span className="text-lg leading-none">{c.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text-1">{c.title}</div>
                  <p className="text-[11.5px] text-text-3 leading-snug">{c.desc}</p>
                </div>
                <button onClick={() => void tryIt(c.key)} className="btn-outline text-[11px] h-7 px-2.5 shrink-0">立即试试</button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setStep(1)} className="btn-primary text-xs h-8">选择 AI 引擎</button>
            <button onClick={() => setMinimized(true)} className="btn-ghost text-xs h-8" title="收起到右下角气泡，随时再看">稍后</button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <h3 className="text-base font-semibold text-text-1 mb-1">AI 在哪里运行？</h3>
          <p className="text-[11px] text-text-3 mb-3">随时可以在「设置」里改。</p>
          <EngineChooser
            stacked
            settings={draft}
            onPick={(m) => setDraft({ ...draft, ai_mode: m, asr_mode: m })}
          />

          {draft.ai_mode === 'builtin' && draft.asr_mode === 'builtin' && (
            <div className="text-[11.5px] text-text-2 mt-3 leading-relaxed space-y-1.5">
              <p>
                选好后自动下载 {missingNames(asrNeed)}（共 {fmtGB(asrNeed.reduce((a, m) => a + m.bytes, 0))}），
                只需一次，之后转录完全离线（国内自动走 OpenCSG / hf-mirror 加速）。下载在后台进行，期间可以照常使用。
              </p>
              {llmNeed.length > 0 && (
                <p className="text-text-3">
                  笔记模型 {missingNames(llmNeed)}（{fmtGB(llmNeed.reduce((a, m) => a + m.bytes, 0))}）较大，不自动下载——需要时到「设置 → AI 运行在哪里」一键获取，下好前的会议会先完成转录。
                </p>
              )}
            </div>
          )}

          {draft.ai_mode === 'cloud' && (
            <div className="space-y-2 mt-3">
            <label className="block">
              <span className="label">LLM API Key</span>
              <input
                className="input font-mono"
                type="password"
                value={draft.llm_api_key}
                onChange={(e) => setDraft({ ...draft, llm_api_key: e.target.value })}
                placeholder="sk-..."
              />
            </label>
            <label className="block">
              <span className="label">ASR API Key</span>
              <input
                className="input font-mono"
                type="password"
                value={draft.asr_api_key}
                onChange={(e) => setDraft({ ...draft, asr_api_key: e.target.value })}
                placeholder="key"
              />
            </label>
            <details>
              <summary className="cursor-pointer text-[11px] text-text-3">高级 · 改 base URL / 模型 / 提供方</summary>
              <div className="mt-2 space-y-2">
                <select
                  className="input"
                  value={draft.llm_provider}
                  onChange={(e) => setDraft({ ...draft, llm_provider: e.target.value as AppSettings['llm_provider'] })}
                >
                  <option value="anthropic-compatible">LLM · Anthropic 兼容</option>
                  <option value="openai-compatible">LLM · OpenAI 兼容</option>
                </select>
                <input className="input text-xs" value={draft.llm_base_url} onChange={(e) => setDraft({ ...draft, llm_base_url: e.target.value })} placeholder="LLM Base URL" />
                <input className="input text-xs" value={draft.llm_model} onChange={(e) => setDraft({ ...draft, llm_model: e.target.value })} placeholder="LLM Model" />
                <select
                  className="input"
                  value={draft.asr_provider}
                  onChange={(e) => setDraft({ ...draft, asr_provider: e.target.value as AppSettings['asr_provider'] })}
                >
                  <option value="minimax">ASR · MiniMax asr-1.0</option>
                  <option value="openai-whisper">ASR · OpenAI Whisper（Groq / OpenAI）</option>
                  <option value="deepgram">ASR · Deepgram Nova-3</option>
                </select>
                <input className="input text-xs" value={draft.asr_base_url} onChange={(e) => setDraft({ ...draft, asr_base_url: e.target.value })} placeholder="ASR Base URL" />
                <input className="input text-xs" value={draft.asr_model} onChange={(e) => setDraft({ ...draft, asr_model: e.target.value })} placeholder="ASR Model" />
              </div>
            </details>
            </div>
          )}

          {draft.ai_mode === 'local' && (
            <p className="text-[11.5px] text-text-2 mt-3 leading-relaxed">
              默认连接本机 Ollama（127.0.0.1:11434）与 whisper.cpp server（127.0.0.1:8080），可在「设置」里改地址和模型。
            </p>
          )}

          <div className="flex items-center gap-2 mt-4">
            <button onClick={() => setStep(0)} className="btn-ghost text-xs h-8">返回</button>
            <button onClick={() => void saveKeysAndNext()} className="btn-primary text-xs h-8 ml-auto">
              {draft.ai_mode === 'builtin' && asrNeed.length > 0 ? '开始下载并继续' : '保存并继续'}
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <h3 className="text-base font-semibold text-text-1 mb-2">一切就绪</h3>
          <p className="text-xs text-text-2 leading-relaxed mb-4">
            左侧栏随时切换 会议 / 任务 / 笔记。
            <br />· {mod()}K 唤出命令面板（跳转 / 录制 / 导出）
            <br />· {mod()}⇧R 随时开始录音，会议自动转录 + 整理成笔记
            {draft.ai_mode === 'builtin' && asrNeed.length > 0 && <><br />· 转录模型正在后台下载，进度见左侧栏</>}
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => goSettings()} className="btn-ghost text-xs h-8">去设置</button>
            <button onClick={() => void close(true)} className="btn-primary text-xs h-8 ml-auto">开始</button>
          </div>
        </div>
      )}
    </div>
  )
}