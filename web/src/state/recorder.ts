import { create } from 'zustand'

/**
 * 录音状态机（UI 与音频引擎共用的单一事实源）。
 * 引擎（src/audio/engine.ts）负责驱动这些状态；
 * 页面只读状态、调用暴露的 action。
 */
export type RecorderPhase =
  | 'idle'        // 未录音
  | 'starting'    // 请求权限中
  | 'recording'   // 录音中
  | 'stopping'    // 停止/收尾中
  | 'error'

export interface ActiveMeetingInfo {
  id: string
  title: string
  startedAt: string
}

/** 当前采集模式 — UI 用来展示 banner（Phase-2: mic + system audio 路径） */
export type CaptureMode = 'mic-only' | 'mic+system' | 'unsupported'

interface RecorderStore {
  phase: RecorderPhase
  meeting: ActiveMeetingInfo | null
  /** 已录时长（ms），由引擎每 250ms 上报 */
  elapsedMs: number
  /** 已落库的分片数（让用户看到"在持续保存"） */
  chunkCount: number
  /** 浏览器录音被中断（切后台/系统打断） */
  interrupted: boolean
  /** 实时麦克风电平 (0..1 RMS)，由 analyser 每 100ms 上报；未录音时为 0 */
  audioLevel: number
  /** 当前采集模式；RecordingBar 据此展示「仅麦克风」honest banner */
  captureMode: CaptureMode
  /** captureMode='unsupported' 时的原因（中文一句话） */
  captureModeNote: string | null
  error: string | null

  // 以下 action 由引擎实现注入（见 audio/engine.ts 的 bindRecorderEngine）
  start: (title?: string) => Promise<void>
  stop: () => Promise<void>
  pauseMarker: () => void
}

export const useRecorder = create<RecorderStore>((set) => ({
  phase: 'idle',
  meeting: null,
  elapsedMs: 0,
  chunkCount: 0,
  interrupted: false,
  audioLevel: 0,
  captureMode: 'mic-only',
  captureModeNote: null,
  error: null,

  // 默认实现会被 engine.ts 覆盖；这里给安全兜底
  start: async () => set({ error: '录音引擎尚未初始化' }),
  stop: async () => undefined,
  pauseMarker: () => undefined,
}))

export function setRecorderPartial(patch: Partial<RecorderStore>): void {
  useRecorder.setState(patch)
}
