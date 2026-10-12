/**
 * Tauri Rust 端 system-audio 命令薄封装。
 *
 * 仅探测/调用；不做实际混音。实际 SCStream 混音/分片在 Rust 端 +
 * audio/engine.ts 协作完成。
 *
 * 本期（MVP）不实装 screencapturekit crate — 详见 src-tauri/src/lib.rs
 * 的 TODO 标记与 README。前端按 `isTauri() && supported` 决定是否走
 * system-audio 路径；不支持一律 mic-only + banner（绝不在 UI 假装成功）。
 */

import { isTauri } from './tauri'
import { invoke } from './tauriInvoke'

/** 系统音频采集的支持/权限状态。 */
export type SystemAudioStatus =
  | { supported: false; reason: string }
  | { supported: true; permission_required: true; permission_granted: boolean; note: string }

const UNSUPPORTED_NOTE =
  'Tauri 端 system-audio 暂未实装 — 浏览器 / 当前构建仅可录制麦克风；' +
  '系统声音需 NotesToGO 桌面版，且首次需在「系统设置 → 隐私与安全性 → 屏幕录制」中允许。'

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
 * 实际启动系统音频采集（混入 mic 流）。
 * 当前 MVP 仅占位：Rust 端返回 'not_implemented'；前端据此 banner。
 * 后续 PR 把 screencapturekit crate 接入后，这里会真正开启 SCStream 并通过
 * Tauri event 把 PCM chunk 推回前端 → audio/engine.ts 合成进 MediaRecorder。
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

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
