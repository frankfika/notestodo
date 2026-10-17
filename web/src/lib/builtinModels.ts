import { create } from 'zustand'
import { isTauri } from './tauri'
import { invoke } from './tauriInvoke'
import { getSettings } from '../db/settings'

/**
 * 应用内置本地模型（Foresight 式）：模型文件由应用自己下载到本机（Hugging Face / hf-mirror / OpenCSG，国内优先国内源），
 * 推理在应用进程内完成（whisper.cpp 转录 + Gemma 4 生成），不依赖 Ollama 等外部服务。
 *
 * 前端只认这一组 Tauri 命令（Rust 端实现）：
 *   builtin_models_list()                      → BackendModel[]
 *   builtin_model_download({ id, sources, file, bytes }) → 立即返回；进度走事件 'builtin_model:progress'
 *   builtin_model_cancel({ id }) / builtin_model_delete({ file })
 *
 * 浏览器版没有这些能力 → builtinAvailable() = false，UI 如实提示「需要桌面版」。
 * DEV 下可用 localStorage.builtin_mock = '1' 打开模拟后端，走完整 UX（下载进度 / 使用 / 失败）。
 */

/** diar = 说话人区分（随内置转录自动下载，不单独选择） */
export type ModelKind = 'asr' | 'llm' | 'diar'

/** 模型在某个托管站点上的位置 */
interface Hosted { repo: string; file: string }

export interface CatalogModel {
  id: string
  kind: ModelKind
  name: string
  /** 一句话说明：适合什么场景 */
  blurb: string
  bytes: number
  /** 本机保存的文件名 */
  file: string
  /** Hugging Face 位置（hf-mirror.com 同路径） */
  hf: Hosted
  /** OpenCSG 位置（国内，阿里云存储）；没有可用镜像则缺省 */
  opencsg?: Hosted
  recommended?: boolean
}

const W = 'ggerganov/whisper.cpp'
const gemma = (size: string): Hosted => ({ repo: `unsloth/gemma-4-${size}-it-qat-GGUF`, file: `gemma-4-${size}-it-qat-UD-Q4_K_XL.gguf` })

// Gemma 用 Unsloth 的 QAT 量化：Hugging Face 与 OpenCSG 都有同名文件（OpenCSG 为稍早版本，元数据差 ~2KB，权重相同）。
// whisper.cpp 在 OpenCSG 上的镜像文件缺失（实测 404），只走 Hugging Face / hf-mirror。
export const CATALOG: CatalogModel[] = [
  {
    id: 'whisper-large-v3-turbo', kind: 'asr', name: 'Whisper Large v3 Turbo', recommended: true,
    blurb: '中文准确率高，速度快，适合日常会议', bytes: 574_041_195,
    file: 'ggml-large-v3-turbo-q5_0.bin', hf: { repo: W, file: 'ggml-large-v3-turbo-q5_0.bin' },
  },
  {
    id: 'whisper-small', kind: 'asr', name: 'Whisper Small',
    blurb: '体积小、转录更快，准确率略低', bytes: 190_085_487,
    file: 'ggml-small-q5_1.bin', hf: { repo: W, file: 'ggml-small-q5_1.bin' },
  },
  // 说话人区分（谁说的）：sherpa-onnx = pyannote 分段 + 3D-Speaker CAM++（阿里达摩院，中文训练），合计约 30MB
  {
    id: 'diar-segmentation', kind: 'diar', name: '说话人分段（pyannote 3.0）',
    blurb: '找出每个人说话的时间段', bytes: 1_540_506,
    file: 'sherpa-pyannote-segmentation-3-0.int8.onnx', hf: { repo: 'csukuangfj/sherpa-onnx-pyannote-segmentation-3-0', file: 'model.int8.onnx' },
  },
  {
    id: 'diar-embedding', kind: 'diar', name: '声纹（3D-Speaker CAM++ 中文）',
    blurb: '区分不同说话人的声音', bytes: 28_281_138,
    file: '3dspeaker_campplus_sv_zh-cn_16k-common.onnx', hf: { repo: 'csukuangfj/speaker-embedding-models', file: '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx' },
  },
  {
    id: 'gemma-4-e4b', kind: 'llm', name: 'Gemma 4 E4B', recommended: true,
    blurb: '质量与速度平衡，16GB 内存推荐', bytes: 4_215_695_776,
    file: gemma('E4B').file, hf: gemma('E4B'), opencsg: gemma('E4B'),
  },
  {
    id: 'gemma-4-e2b', kind: 'llm', name: 'Gemma 4 E2B',
    blurb: '最轻量，8GB 内存也能跑，笔记略简单', bytes: 2_620_370_976,
    file: gemma('E2B').file, hf: gemma('E2B'), opencsg: gemma('E2B'),
  },
  {
    id: 'gemma-4-12b', kind: 'llm', name: 'Gemma 4 12B',
    blurb: '笔记质量最好，需要 16GB 以上内存，较慢', bytes: 6_716_356_800,
    file: gemma('12B').file, hf: gemma('12B'), opencsg: gemma('12B'),
  },
]

// ── 下载源（国内用户优先国内源）──────────────────────────────────────

export type ModelSource = 'auto' | 'huggingface' | 'hf-mirror' | 'opencsg'

export const SOURCE_LABELS: Record<ModelSource, string> = {
  auto: '自动（国内优先国内源）',
  huggingface: 'Hugging Face',
  'hf-mirror': 'HF 镜像 hf-mirror.com（国内）',
  opencsg: 'OpenCSG（国内 · 阿里云）',
}

/** 粗判是否在中国大陆：时区或系统语言 */
export function inMainlandChina(): boolean {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  return ['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'Asia/Urumqi'].includes(tz) || navigator.language === 'zh-CN'
}

export interface DownloadSource { url: string; family: 'hf' | 'opencsg'; key: Exclude<ModelSource, 'auto'> }

/** 按偏好排好的候选下载源：首选失败自动换下一个 */
export function sourcesFor(m: CatalogModel, pref: ModelSource, china = inMainlandChina()): DownloadSource[] {
  const all: DownloadSource[] = [
    { key: 'huggingface', family: 'hf', url: `https://huggingface.co/${m.hf.repo}/resolve/main/${m.hf.file}` },
    { key: 'hf-mirror', family: 'hf', url: `https://hf-mirror.com/${m.hf.repo}/resolve/main/${m.hf.file}` },
    ...(m.opencsg ? [{ key: 'opencsg' as const, family: 'opencsg' as const, url: `https://hub.opencsg.com/api/v1/models/${m.opencsg.repo}/resolve/${m.opencsg.file}?ref=main` }] : []),
  ]
  const order: DownloadSource['key'][] = pref === 'auto'
    ? (china ? ['opencsg', 'hf-mirror', 'huggingface'] : ['huggingface', 'hf-mirror', 'opencsg'])
    : [pref, ...(['hf-mirror', 'opencsg', 'huggingface'] as const).filter((k) => k !== pref)]
  return order.map((k) => all.find((x) => x.key === k)).filter((x): x is DownloadSource => !!x)
}

export const DEFAULT_BUILTIN = { asr: 'whisper-large-v3-turbo', llm: 'gemma-4-e4b' } as const

/** 说话人区分的两个模型（随内置转录一起下载） */
export const DIAR_IDS = ['diar-segmentation', 'diar-embedding'] as const

export const catalogById = (id: string): CatalogModel | undefined => CATALOG.find((m) => m.id === id)

export type ModelState =
  | { state: 'absent' }
  /** 上次没下完，再点会从断点续传 */
  | { state: 'partial'; received: number }
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
  download(m: CatalogModel, sources: DownloadSource[]): Promise<void>
  cancel(id: string): Promise<void>
  remove(id: string): Promise<void>
}

type Progress = { id: string; received: number; total: number; done?: boolean; error?: string }

function handleProgress(p: Progress): void {
  if (p.error) {
    // 取消 / 失败都保留已下部分，下次续传
    const prev = modelState(p.id)
    const got = prev.state === 'downloading' ? prev.received : 0
    setModel(p.id, p.error === 'cancelled'
      ? (got > 0 ? { state: 'partial', received: got } : { state: 'absent' })
      : { state: 'error', error: p.error })
    return
  }
  if (p.done) { setModel(p.id, { state: 'ready' }); for (const fn of readyListeners) fn(p.id); return }
  setModel(p.id, { state: 'downloading', received: p.received, total: p.total })
}

const tauriBackend: Backend = {
  list: () => invoke('builtin_models_list', { catalog: CATALOG.map(({ id, file, bytes }) => ({ id, file, bytes })) }),
  download: (m, sources) => invoke('builtin_model_download', { id: m.id, sources: sources.map(({ url, family }) => ({ url, family })), file: m.file, bytes: m.bytes }),
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
    for (const r of rows) {
      models[r.id] = r.state === 'ready' ? { state: 'ready' }
        : r.state === 'partial' ? { state: 'partial', received: r.received ?? 0 } : { state: 'absent' }
    }
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
  const prev = modelState(id)
  setModel(id, { state: 'downloading', received: prev.state === 'partial' ? prev.received : 0, total: m.bytes })
  try {
    await backend().download(m, sourcesFor(m, (await getSettings()).model_source))
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
