import { type JSX, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { DEFAULT_SETTINGS, type AppSettings } from '../types'
import { saveSettings } from '../db/settings'
import { useUI } from '../state/ui'
import { mod } from '../lib/id'
import { EngineChooser, useMissingBuiltin, missingNames } from './BuiltinModels'
import { downloadModel, fmtGB } from '../lib/builtinModels'
import { createPage } from '../lib/notes'
import { completeOnboarding } from '../onboarding/state'
import { useRecorder } from '../state/recorder'

/**
 * 首次启动引导：不再把「开始干活」和「配置 AI」混成一个三步弹窗。
 *
 * 交互原则：
 * 1. 第一屏只回答“现在先做什么”；
 * 2. AI 配置是第二层，不强迫用户先理解模型与 provider；
 * 3. 任何真实动作（开始录音 / 新建笔记 / 打开任务）都应把引导让开。
 *
 * 完成 / 关闭事件通过 db.kv['onboarding_done_v1'] 持久化，外部代码
 * （如开始录音）也可以写入它表示用户已上手。
 */

function QuickLane({
  emoji,
  title,
  desc,
  action,
}: {
  emoji: string
  title: string
  desc: string
  action: JSX.Element
}): JSX.Element {
  return (
    <div className="rounded-2xl border border-line bg-bg px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-overlay text-lg">
          {emoji}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-1">{title}</div>
          <p className="mt-1 text-[12px] leading-relaxed text-text-3">{desc}</p>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
    </div>
  )
}

export default function Onboarding(): JSX.Element | null {
  const [minimized, setMinimized] = useState(() => typeof window !== 'undefined' && window.innerWidth < 1440)
  const [showEngineSetup, setShowEngineSetup] = useState(false)
  const [draft, setDraft] = useState<AppSettings>(DEFAULT_SETTINGS)
  const goSettings = useUI((s) => s.goSettings)
  const goNote = useUI((s) => s.goNote)
  const goTodos = useUI((s) => s.goTodos)
  const startRecording = useRecorder((s) => s.start)
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
    if (done) await completeOnboarding()
    // 不需要 setOpen(false)：liveQuery 会驱动重新渲染
  }

  async function saveEngine(): Promise<void> {
    await saveSettings(draft)
    if (draft.ai_mode === 'builtin') for (const m of asrNeed) void downloadModel(m.id)
    await close(true)
  }

  async function startNote(): Promise<void> {
    await close(true)
    goNote(await createPage())
  }

  async function openTasks(): Promise<void> {
    await close(true)
    goTodos()
  }

  async function beginRecording(): Promise<void> {
    setMinimized(true)
    await startRecording()
  }

  if (!open) return null

  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="fixed bottom-20 md:bottom-5 right-3 md:right-5 z-40 card px-4 py-3 shadow-2xl hover:border-accent/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-accent text-sm leading-none">●</span>
          <span className="text-sm text-text-1 font-medium">开始使用</span>
          <span className="text-[11px] text-text-3">先做第一件事</span>
        </div>
      </button>
    )
  }

  return (
    <div
      className="fixed bottom-20 md:bottom-5 right-3 md:right-5 z-40 w-[420px] max-w-[calc(100vw-1.5rem)] card p-5 shadow-2xl"
      role="dialog"
    >
      <div className="mb-4 flex items-center gap-2">
        <span className="section-title">{showEngineSetup ? 'AI 设置' : '开始使用'}</span>
        <button
          onClick={() => setMinimized(true)}
          className="icon-btn ml-auto"
          title="先收起来"
          aria-label="最小化"
        >—</button>
        <button
          onClick={() => void close(true)}
          className="icon-btn"
          title="关闭引导"
          aria-label="关闭"
        >✕</button>
      </div>

      {!showEngineSetup ? (
        <div>
          <h3 className="text-[22px] font-semibold leading-tight text-text-1">先做第一件事，不用先学概念</h3>
          <p className="mt-2 text-sm leading-relaxed text-text-2">
            这里最容易劝退人的地方，就是一上来先讲 AI、先讲引擎、先讲模型。真正顺的开始方式应该是：
            你先开始一件事，剩下的边用边补。
          </p>
          <div className="mt-4 space-y-2.5">
            <QuickLane
              emoji="🎙"
              title="先开一场会"
              desc={`直接开始录音，系统会把会议转成纪要、笔记和待办。快捷键 ${mod()}⇧R。`}
              action={
                <button onClick={() => void beginRecording()} className="btn-primary h-8 px-3 text-xs">
                  ● 开始录音
                </button>
              }
            />
            <QuickLane
              emoji="📝"
              title="先写一页笔记"
              desc="先把想法记下来，后面再慢慢整理结构、双链和标签。"
              action={
                <button onClick={() => void startNote()} className="btn-outline h-8 px-3 text-xs">
                  新建笔记
                </button>
              }
            />
            <QuickLane
              emoji="✅"
              title="先理一下任务"
              desc="把手头事项放进任务树或脑图里，今天先知道下一步做什么。"
              action={
                <button onClick={() => void openTasks()} className="btn-outline h-8 px-3 text-xs">
                  打开任务
                </button>
              }
            />
          </div>

          <div className="mt-4 rounded-2xl border border-line bg-bg px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-overlay text-base">
                ✦
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-1">AI 可以稍后再配</div>
                <p className="mt-1 text-[12px] leading-relaxed text-text-3">
                  不管你选本地、云端还是内置模型，都不该挡在第一步前面。需要时再进来配就行。
                </p>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button onClick={() => setShowEngineSetup(true)} className="btn-outline h-8 px-3 text-xs">
                现在配置 AI
              </button>
              <button onClick={() => setMinimized(true)} className="btn-ghost h-8 px-3 text-xs">
                我先自己逛逛
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <h3 className="text-[20px] font-semibold leading-tight text-text-1">AI 运行方式可以慢慢选</h3>
          <p className="mt-2 text-sm leading-relaxed text-text-2">
            这里只做一件事：决定 AI 跑在哪里。以后随时都能在设置里改，不用现在把所有概念一次吃完。
          </p>
          <p className="mt-2 text-[12px] text-text-3">推荐顺序：先开用，跑顺了再优化模型和 provider。</p>

          <div className="mt-4">
          <EngineChooser
            stacked
            settings={draft}
            onPick={(m) => setDraft({ ...draft, ai_mode: m, asr_mode: m })}
          />
          </div>

          {draft.ai_mode === 'builtin' && draft.asr_mode === 'builtin' && (
            <div className="mt-3 space-y-1.5 rounded-2xl border border-line bg-bg px-4 py-3 text-[11.5px] leading-relaxed text-text-2">
              <p>
                选好后会自动下载 {missingNames(asrNeed)}（共 {fmtGB(asrNeed.reduce((a, m) => a + m.bytes, 0))}），
                之后转录就能完全离线。下载在后台进行，不会挡住你继续用。
              </p>
              {llmNeed.length > 0 && (
                <p className="text-text-3">
                  笔记模型 {missingNames(llmNeed)}（{fmtGB(llmNeed.reduce((a, m) => a + m.bytes, 0))}）更大，
                  暂时不会自动下；真的需要时再去设置里拉就行。
                </p>
              )}
            </div>
          )}

          {draft.ai_mode === 'cloud' && (
            <div className="mt-3 space-y-2">
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
            <p className="mt-3 rounded-2xl border border-line bg-bg px-4 py-3 text-[11.5px] leading-relaxed text-text-2">
              默认连接本机 Ollama（127.0.0.1:11434）与 whisper.cpp server（127.0.0.1:8080），可在「设置」里改地址和模型。
            </p>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button onClick={() => setShowEngineSetup(false)} className="btn-ghost text-xs h-8">返回</button>
            <button onClick={() => goSettings()} className="btn-ghost text-xs h-8">高级设置</button>
            <button onClick={() => void saveEngine()} className="btn-primary text-xs h-8 ml-auto">
              {draft.ai_mode === 'builtin' && asrNeed.length > 0 ? '保存并开始下载' : '保存设置'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
