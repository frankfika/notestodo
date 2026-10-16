import { useEffect } from 'react'
import {
  CATALOG, builtinAvailable, cancelDownload, deleteModel, downloadModel, fmtGB,
  refreshBuiltinModels, useBuiltinModels, type CatalogModel, type ModelKind, type ModelState,
} from '../lib/builtinModels'
import type { AiMode, AppSettings } from '../types'
import { useUI } from '../state/ui'

/** 「AI 运行在哪里」三选一：同时设定转录与笔记两侧；两侧不同显示为「混合」 */
const ENGINES: { mode: AiMode; title: string; sub: string; badge?: string }[] = [
  { mode: 'builtin', title: '本机内置', sub: '模型下载到这台电脑，完全离线，录音和笔记不出本机', badge: '推荐' },
  { mode: 'cloud', title: '云端 API', sub: '用你自己的 API Key（MiniMax / OpenAI / Anthropic 兼容），速度快' },
  { mode: 'local', title: '自建本地服务', sub: '高级：连接你已运行的 Ollama / LM Studio / whisper.cpp server' },
]

export function EngineChooser({ settings, onPick, stacked }: {
  settings: Pick<AppSettings, 'ai_mode' | 'asr_mode'>
  onPick: (mode: AiMode) => void
  /** 窄容器（引导面板）里纵向排列 */
  stacked?: boolean
}): JSX.Element {
  const available = builtinAvailable()
  const mixed = settings.ai_mode !== settings.asr_mode
  return (
    <div role="radiogroup" aria-label="AI 运行在哪里" className={`grid gap-2 ${stacked ? '' : 'sm:grid-cols-3'}`}>
      {ENGINES.map((e) => {
        const active = !mixed && settings.ai_mode === e.mode
        const disabled = e.mode === 'builtin' && !available
        return (
          <button
            key={e.mode}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onPick(e.mode)}
            className={`text-left rounded-xl border p-3 transition-colors ${
              active ? 'border-accent bg-accent/6 ring-1 ring-accent/30' : 'border-line hover:border-line-strong'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-3.5 w-3.5 rounded-full border flex items-center justify-center ${active ? 'border-accent' : 'border-line-strong'}`}>
                {active && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              </span>
              <span className="text-sm font-medium text-text-1">{e.title}</span>
              {e.badge && <span className="text-[10px] px-1.5 rounded bg-accent/12 text-accent">{e.badge}</span>}
            </div>
            <p className="text-[11.5px] text-text-3 mt-1 leading-snug">
              {disabled ? '需要 macOS 桌面版（浏览器无法运行内置模型）' : e.sub}
            </p>
          </button>
        )
      })}
      {mixed && (
        <p className={`${stacked ? '' : 'sm:col-span-3'} text-[11px] text-text-3`}>
          当前为混合模式：转录用「{label(settings.asr_mode)}」，笔记用「{label(settings.ai_mode)}」。点上面任一项统一切换。
        </p>
      )}
    </div>
  )
}

const label = (m: AiMode): string => ENGINES.find((e) => e.mode === m)?.title ?? m

/** 一组模型（转录 or 笔记）：单选使用哪个 + 每个的下载状态 */
export function ModelPicker({ kind, selected, onSelect }: {
  kind: ModelKind
  selected: string
  onSelect: (id: string) => void
}): JSX.Element {
  const models = useBuiltinModels((s) => s.models)
  useEffect(() => { void refreshBuiltinModels() }, [])
  const list = CATALOG.filter((m) => m.kind === kind)
  return (
    <div className="space-y-2" role="radiogroup" aria-label={kind === 'asr' ? '转录模型' : '笔记模型'}>
      {list.map((m) => (
        <ModelRow key={m.id} m={m} st={models[m.id] ?? { state: 'absent' }} selected={selected === m.id} onSelect={() => onSelect(m.id)} />
      ))}
    </div>
  )
}

function ModelRow({ m, st, selected, onSelect }: { m: CatalogModel; st: ModelState; selected: boolean; onSelect: () => void }): JSX.Element {
  const pct = st.state === 'downloading' && st.total > 0 ? Math.floor((st.received / st.total) * 100) : 0
  return (
    <div
      data-model={m.id}
      className={`rounded-xl border px-3 py-2.5 ${selected ? 'border-accent/60 bg-accent/4' : 'border-line'}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          onClick={onSelect}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          title="使用这个模型"
        >
          <span className={`h-3.5 w-3.5 shrink-0 rounded-full border flex items-center justify-center ${selected ? 'border-accent' : 'border-line-strong'}`}>
            {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
          </span>
          <span className="text-sm text-text-1 font-medium truncate">{m.name}</span>
          {m.recommended && <span className="text-[10px] px-1.5 rounded bg-accent/12 text-accent shrink-0">推荐</span>}
          <span className="text-[11px] text-text-3 tabular-nums shrink-0">{fmtGB(m.bytes)}</span>
        </button>
        <ModelAction m={m} st={st} />
      </div>
      <p className="text-[11.5px] text-text-3 mt-1 ml-[22px]">{m.blurb}</p>
      {st.state === 'downloading' && (
        <div className="ml-[22px] mt-2">
          <div className="h-1.5 rounded-full bg-bg-overlay overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-[11px] text-text-3 mt-1 tabular-nums">{pct}% · {fmtGB(st.received)} / {fmtGB(st.total)}（可离开此页，后台继续）</div>
        </div>
      )}
      {st.state === 'error' && <p className="text-[11px] text-danger mt-1 ml-[22px]">下载失败：{st.error}（点「重试」从断点继续）</p>}
    </div>
  )
}

function ModelAction({ m, st }: { m: CatalogModel; st: ModelState }): JSX.Element {
  switch (st.state) {
    case 'ready':
      return (
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-accent">✓ 已下载</span>
          <button
            type="button"
            onClick={() => { if (window.confirm(`删除 ${m.name}（${fmtGB(m.bytes)}）？需要时可重新下载。`)) void deleteModel(m.id) }}
            className="text-[11px] text-text-3 hover:text-danger"
          >删除</button>
        </span>
      )
    case 'downloading':
      return <button type="button" onClick={() => void cancelDownload(m.id)} className="btn-ghost text-[11px] h-7 px-2 shrink-0">取消</button>
    case 'error':
      return <button type="button" onClick={() => void downloadModel(m.id)} className="btn-outline text-[11px] h-7 px-2.5 shrink-0">重试</button>
    default:
      return <button type="button" onClick={() => void downloadModel(m.id)} className="btn-outline text-[11px] h-7 px-2.5 shrink-0">下载</button>
  }
}

/** 侧栏 / 底栏用：有模型在下载时显示总进度，点了去设置 */
export function DownloadIndicator(): JSX.Element | null {
  const models = useBuiltinModels((s) => s.models)
  const goSettings = useUI((s) => s.goSettings)
  const active = Object.values(models).filter((s): s is Extract<ModelState, { state: 'downloading' }> => s.state === 'downloading')
  if (active.length === 0) return null
  const received = active.reduce((a, s) => a + s.received, 0)
  const total = active.reduce((a, s) => a + s.total, 0)
  const pct = total > 0 ? Math.floor((received / total) * 100) : 0
  return (
    <button onClick={goSettings} className="w-full text-left rounded-lg border border-line px-2.5 py-2 hover:bg-bg-overlay" title="查看模型下载">
      <div className="flex items-center text-[11px] text-text-2">
        <span>下载本地模型</span>
        <span className="ml-auto tabular-nums text-text-3">{pct}%</span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-bg-overlay overflow-hidden">
        <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
    </button>
  )
}

/** 当前选择的内置模型是否都已就绪；返回缺失的模型名（用于各处提示） */
export function useMissingBuiltin(settings: Pick<AppSettings, 'ai_mode' | 'asr_mode' | 'builtin_asr_model' | 'builtin_llm_model'> | undefined): CatalogModel[] {
  const models = useBuiltinModels((s) => s.models)
  if (!settings) return []
  const need: string[] = []
  if (settings.asr_mode === 'builtin') need.push(settings.builtin_asr_model)
  if (settings.ai_mode === 'builtin') need.push(settings.builtin_llm_model)
  return need
    .filter((id) => models[id]?.state !== 'ready')
    .map((id) => CATALOG.find((m) => m.id === id))
    .filter((m): m is CatalogModel => !!m)
}
