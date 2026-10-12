/**
 * Tauri host detection.
 *
 * 浏览器与 Tauri 2 (WKWebView) 行为不同：
 *   - 浏览器仅可 getUserMedia(麦克风) — 系统声音拿不到（DRM/平台限制）
 *   - Tauri macOS 端可借 ScreenCaptureKit (系统音频 loopback) 拿到会议播放声；
 *     需 macOS 屏录权限（用户在「系统设置 → 隐私与安全性 → 屏幕录制」批准）
 *
 * 不放任何命令调用 — 见 ./tauriSystemAudio.ts。
 */

/** 是否运行在 Tauri 壳里（mac 原生 app）。 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  // Tauri 2 在 webview 内注入 __TAURI_INTERNALS__（不需要全局 __TAURI__）
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  return Boolean(w.__TAURI_INTERNALS__)
}
