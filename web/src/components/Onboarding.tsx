import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { DEFAULT_SETTINGS, type AppSettings } from '../types'
import { saveSettings } from '../db/settings'
import { useUI } from '../state/ui'
import { mod } from '../lib/id'

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
    setStep(2)
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
          onClick={() => void close(false)}
          className="icon-btn"
          title="关闭引导"
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
          <h3 className="text-base font-semibold text-text-1 mb-2">开会时只管说话</h3>
          <p className="text-xs text-text-2 leading-relaxed mb-4">
            按 <span className="kbd">{mod()}⇧R</span> 一键录音；录音结束自动转录 + 生成纪要 + 提取行动项。
            所有数据存你本机 IndexedDB，导出 .zip 备份即可带走。
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => setStep(1)} className="btn-primary text-xs h-8">填 API Key</button>
            <button onClick={() => void close(false)} className="btn-ghost text-xs h-8">稍后</button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <h3 className="text-base font-semibold text-text-1 mb-2">两把钥匙 — LLM 与 ASR</h3>
          <p className="text-[11px] text-text-3 mb-3">BYOK，地址已默认 MiniMax 端点。</p>

          <div className="space-y-2">
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

          <div className="flex items-center gap-2 mt-4">
            <button onClick={() => setStep(0)} className="btn-ghost text-xs h-8">返回</button>
            <button onClick={() => void saveKeysAndNext()} className="btn-primary text-xs h-8 ml-auto">
              保存并继续
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <h3 className="text-base font-semibold text-text-1 mb-2">一切就绪</h3>
          <p className="text-xs text-text-2 leading-relaxed mb-4">
            按 <span className="kbd">{mod()}⇧R</span> 开始录音。
            <br />· {mod()}K 唤出命令面板（跳转 / 录制 / 导出）
            <br />· 录制完成的会议会出现在「会议」列表，自动转录 + 总结
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