/**
 * Tauri Rust 端 system-audio 命令薄封装。
 *
 * 仅探测/调用；混音在 audio/systemMix.ts（PCM → AudioContext →
 * MediaStreamDestination，由 audio/engine.ts 接线）。SCStream 采集见
 * src-tauri/src/system_audio.rs。
 *
 * 前端按 `isTauri() && supported` 决定是否走 system-audio 路径；
 * 不支持一律 mic-only + banner（绝不在 UI 假装成功）。
 */

import { isTauri } from './tauri'
import { invoke } from './tauriInvoke'

/** 系统音频采集的支持/权限状态。 */
export type SystemAudioStatus =
  | { supported: false; reason: string }
  | { supported: true; permission_required: true; permission_granted: boolean; note: string }

const UNSUPPORTED_NOTE =
  'Tauri 端 system-audio 已实装 ScreenCaptureKit 接线；当前可能未授权屏幕录制。' +
  '请到「系统设置 → 隐私与安全性 → 屏幕录制」中允许 NotesToGO。'

/** 探测 Rust 端 system-audio 能力。失败（不在 Tauri / 无命令 / 抛错）一律降级到 mic-only。 */
export async function systemAudioStatus(): Promise<SystemAudioStatus> {
  if (!isTauri()) {
    return { supported: false, reason: 'web' }
  }
  try {
    const res = await invoke<{
      supported: boolean
      permission_required?: boolean
      permission_granted?: boolean
      note?: string
    }>('system_audio_status')
    if (!res?.supported) {
      return { supported: false, reason: res?.note ?? UNSUPPORTED_NOTE }
    }
    return {
      supported: true,
      permission_required: true,
      permission_granted: Boolean(res.permission_granted),
      note: res.note ?? UNSUPPORTED_NOTE,
    }
  } catch (e) {
    return { supported: false, reason: `system_audio_status 调用失败：${describe(e)}` }
  }
}

/**
 * 实际启动系统音频采集（SCStream + Tauri event → audio/engine.ts）。
 *
 * 成功 → { ok: true, mode: 'mic+system' }（captureMode 翻 'mic+system'）
 * 失败 → { ok: false, reason: '...' }（captureMode 翻 'unsupported' + banner）
 *
 * 重要：start 之前 Rust 一定真的跑到了 SCStream::start_capture()。失败原因
 * （TCC / shareable content / filter / handler / start_capture）会原样回传。
 */
export type SystemAudioStartResult =
  | { ok: true; mode: 'mic+system' }
  | { ok: false; reason: string }

export async function startSystemAudio(): Promise<SystemAudioStartResult> {
  if (!isTauri()) return { ok: false, reason: 'web' }
  try {
    const res = await invoke<{ started: boolean; reason?: string }>('system_audio_start')
    if (res?.started) return { ok: true, mode: 'mic+system' }
    return { ok: false, reason: res?.reason ?? 'unknown' }
  } catch (e) {
    return { ok: false, reason: describe(e) }
  }
}

export async function stopSystemAudio(): Promise<void> {
  if (!isTauri()) return
  try {
    await invoke('system_audio_stop')
  } catch (e) {
    // ignore — best-effort
    console.warn('stopSystemAudio 失败', e)
  }
}

// ── 屏录授权引导（PermissionGuide 使用）─────────────────────────────

/** 触发系统授权弹窗；返回调用当下是否已授权。 */
export async function requestScreenPermission(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return Boolean(await invoke<boolean>('system_audio_request_permission'))
  } catch {
    return false
  }
}

/** 直达「系统设置 → 隐私与安全性 → 屏幕录制」。 */
export async function openScreenRecordingSettings(): Promise<void> {
  if (!isTauri()) return
  await invoke('open_screen_recording_settings')
}

/** 重启 App 使授权生效。 */
export async function restartApp(): Promise<void> {
  if (!isTauri()) return
  await invoke('restart_app')
}

// ── system_audio:chunk 事件订阅（Phase-3 Gap 1）────────────────────────
//
// Rust 端 SCStream 把 interleaved f32 PCM 按 ~30ms 一批推过来，
// audio/systemMix.ts 订阅后排进 AudioContext 与麦克风混录。

import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface SystemAudioChunk {
  samples: number[]
  sample_rate: number
  channels: number
  cumulative_samples: number
}

export type ChunkHandler = (chunk: SystemAudioChunk) => void

/**
 * 订阅 system_audio:chunk 事件。
 * 不在 Tauri / 监听失败 → 返回一个 no-op unlisten。
 */
export async function onSystemAudioChunk(handler: ChunkHandler): Promise<UnlistenFn> {
  if (!isTauri()) return () => {}
  try {
    const unlisten = await listen<SystemAudioChunk>('system_audio:chunk', (event) => {
      handler(event.payload)
    })
    return unlisten
  } catch (e) {
    console.warn('onSystemAudioChunk 失败：', e)
    return () => {}
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
