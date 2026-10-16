import { create } from 'zustand'
import { isTauri } from './tauri'
import { invoke } from './tauriInvoke'

/**
 * 应用内置本地模型（Foresight 式）：模型文件由应用自己从 Hugging Face 下载到本机，
 * 推理在应用进程内完成（whisper.cpp 转录 + Gemma 4 生成），不依赖 Ollama 等外部服务。
 *
 * 前端只认这一组 Tauri 命令（Rust 端实现）：
 *   builtin_models_list()                      → BackendModel[]
 *   builtin_model_download({ id, url, file })  → 立即返回；进度走事件 'builtin_model:progress'
 *   builtin_model_cancel({ id }) / builtin_model_delete({ id })
 *
 * 浏览器版没有这些能力 → builtinAvailable() = false，UI 如实提示「需要桌面版」。
 * DEV 下可用 localStorage.builtin_mock = '1' 打开模拟后端，走完整 UX（下载进度 / 使用 / 失败）。
 */

export type ModelKind = 'asr' | 'llm'

export interface CatalogModel {
  id: string
  kind: ModelKind
  name: string
  /** 一句话说明：适合什么场景 */
  blurb: string
  bytes: number
  url: string
  file: string
  recommended?: boolean
}

const HF = 'https://huggingface.co'

export const CATALOG: CatalogModel[] = [
  {
    id: 'whisper-large-v3-turbo', kind: 'asr', name: 'Whisper Large v3 Turbo', recommended: true,
    blurb: '中文准确率高，速度快，适合日常会议', bytes: 574_000_000,
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`, file: 'ggml-large-v3-turbo-q5_0.bin',
  },
  {
    id: 'whisper-small', kind: 'asr', name: 'Whisper Small',
    blurb: '体积小、转录更快，准确率略低', bytes: 190_000_000,
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin`, file: 'ggml-small-q5_1.bin',
  },
  {
    id: 'gemma-4-e4b', kind: 'llm', name: 'Gemma 4 E4B', recommended: true,
    blurb: '质量与速度平衡，16GB 内存推荐', bytes: 5_150_000_000,
    url: `${HF}/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/main/gemma-4-E4B_q4_0-it.gguf`, file: 'gemma-4-E4B_q4_0-it.gguf',
  },
  {
    id: 'gemma-4-e2b', kind: 'llm', name: 'Gemma 4 E2B',
    blurb: '最轻量，8GB 内存也能跑，笔记略简单', bytes: 3_350_000_000,
    url: `${HF}/google/gemma-4-E2B-it-qat-q4_0-gguf/resolve/main/gemma-4-E2B_q4_0-it.gguf`, file: 'gemma-4-E2B_q4_0-it.gguf',
  },
  {
    id: 'gemma-4-12b', kind: 'llm', name: 'Gemma 4 12B',
    blurb: '笔记质量最好，需要 16GB 以上内存，较慢', bytes: 6_980_000_000,
    url: `${HF}/google/gemma-4-12B-it-qat-q4_0-gguf/resolve/main/gemma-4-12b-it-qat-q4_0.gguf`, file: 'gemma-4-12b-it-qat-q4_0.gguf',
  },
]

export const DEFAULT_BUILTIN = { asr: 'whisper-large-v3-turbo', llm: 'gemma-4-e4b' } as const

export const catalogById = (id: string): CatalogModel | undefined => CATALOG.find((m) => m.id === id)

export type ModelState =
  | { state: 'absent' }
  | { state: 'downloading'; received: number; total: number }
  | { state: 'ready' }
  | { state: 'error'; error: string }

interface Store { models: Record<string, ModelState>; loaded: boolean }
export const useBuiltinModels = create<Store>(() => ({ models: {}, loaded: false }))

const setModel = (id: string, s: ModelState): void =>
  useBuiltinModels.setState((st) => ({ models: { ...st.models, [id]: s } }))

export const modelState = (id: string): ModelState => useBuiltinModels.getState().models[id] ?? { state: 'absent' }
export const isReady = (id: string): boolean => modelState(id).state === 'ready'

/** 下载完成后要做的事（如：自动续跑因模型缺失而搁置的会议）；由 pipeline 注册，避免循环依赖 */
const readyListeners: ((id: string) => void)[] = []
export const onModelReady = (fn: (id: string) => void): void => { readyListeners.push(fn) }

// ── 后端 ──────────────────────────────────────────────────────────

interface Backend {
  list(): Promise<{ id: string; state: 'ready' | 'absent' | 'partial'; received?: number }[]>
  download(m: CatalogModel): Promise<void>
  cancel(id: string): Promise<void>
  remove(id: string): Promise<void>
}

type Progress = { id: string; received: number; total: number; done?: boolean; error?: string }

function handleProgress(p: Progress): void {
  if (p.error) { setModel(p.id, p.error === 'cancelled' ? { state: 'absent' } : { state: 'error', error: p.error }); return }
  if (p.done) { setModel(p.id, { state: 'ready' }); for (const fn of readyListeners) fn(p.id); return }
  setModel(p.id, { state: 'downloading', received: p.received, total: p.total })
}

const tauriBackend: Backend = {
  list: () => invoke('builtin_models_list', { catalog: CATALOG.map(({ id, file, bytes }) => ({ id, file, bytes })) }),
  download: (m) => invoke('builtin_model_download', { id: m.id, url: m.url, file: m.file, bytes: m.bytes }),
  cancel: (id) => invoke('builtin_model_cancel', { id }),
  remove: (id) => invoke('builtin_model_delete', { id, file: catalogById(id)?.file }),
}

// DEV 模拟后端：~4 秒下完，状态存 localStorage；URL 带 fail 的模型模拟断网
const MOCK_KEY = 'builtin_mock_ready'
const mockTimers = new Map<string, ReturnType<typeof setInterval>>()
const mockReady = (): string[] => JSON.parse(localStorage.getItem(MOCK_KEY) ?? '[]') as string[]
const mockBackend: Backend = {
  list: async () => CATALOG.map((m) => ({ id: m.id, state: mockReady().includes(m.id) ? 'ready' as const : 'absent' as const })),
  download: async (m) => {
    let received = 0
    const failAt = localStorage.getItem('builtin_mock_fail') === m.id ? m.bytes * 0.4 : Infinity
    mockTimers.set(m.id, setInterval(() => {
      received = Math.min(m.bytes, received + m.bytes / 20)
      if (received >= failAt) {
        clearInterval(mockTimers.get(m.id)); mockTimers.delete(m.id)
        handleProgress({ id: m.id, received, total: m.bytes, error: '网络中断（模拟）' })
        return
      }
      if (received >= m.bytes) {
        clearInterval(mockTimers.get(m.id)); mockTimers.delete(m.id)
        localStorage.setItem(MOCK_KEY, JSON.stringify([...new Set([...mockReady(), m.id])]))
        handleProgress({ id: m.id, received, total: m.bytes, done: true })
      } else handleProgress({ id: m.id, received, total: m.bytes })
    }, 200))
  },
  cancel: async (id) => {
    clearInterval(mockTimers.get(id)); mockTimers.delete(id)
    handleProgress({ id, received: 0, total: 0, error: 'cancelled' })
  },
  remove: async (id) => { localStorage.setItem(MOCK_KEY, JSON.stringify(mockReady().filter((x) => x !== id))) },
}

export const mockEnabled = (): boolean =>
  import.meta.env.DEV && typeof localStorage !== 'undefined' && localStorage.getItem('builtin_mock') === '1'

/** 能否用内置模型：桌面版，或 DEV 模拟 */
export const builtinAvailable = (): boolean => isTauri() || mockEnabled()

const backend = (): Backend => (isTauri() ? tauriBackend : mockBackend)

let listening = false
export async function refreshBuiltinModels(): Promise<void> {
  if (!builtinAvailable()) { useBuiltinModels.setState({ loaded: true }); return }
  if (isTauri() && !listening) {
    listening = true
    const { listen } = await import('@tauri-apps/api/event')
    await listen<Progress>('builtin_model:progress', (e) => handleProgress(e.payload))
  }
  try {
    const rows = await backend().list()
    const models: Record<string, ModelState> = {}
    for (const r of rows) models[r.id] = r.state === 'ready' ? { state: 'ready' } : { state: 'absent' }
    // 保留进行中的下载状态
    for (const [id, s] of Object.entries(useBuiltinModels.getState().models)) if (s.state === 'downloading') models[id] = s
    useBuiltinModels.setState({ models, loaded: true })
  } catch (e) {
    console.warn('读取内置模型状态失败', e)
    useBuiltinModels.setState({ loaded: true })
  }
}

export async function downloadModel(id: string): Promise<void> {
  const m = catalogById(id)
  if (!m || modelState(id).state === 'downloading' || isReady(id)) return
  setModel(id, { state: 'downloading', received: 0, total: m.bytes })
  try {
    await backend().download(m)
  } catch (e) {
    setModel(id, { state: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}
export const cancelDownload = (id: string): Promise<void> => backend().cancel(id)
export async function deleteModel(id: string): Promise<void> {
  await backend().remove(id)
  setModel(id, { state: 'absent' })
}

export const fmtGB = (b: number): string => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`
