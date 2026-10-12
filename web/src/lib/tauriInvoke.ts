/**
 * Tauri 2 invoke() 薄封装 + 浏览器降级。
 *
 * `@tauri-apps/api` 已在 `web/package.json` 的 dependencies；Phase-3 直接用
 * 静态 `import { invoke } from '@tauri-apps/api/core'`，不再走 `new Function`
 * + dynamic import（Vite 1.x 的 import-analysis hack，新版本已无必要）。
 *
 * 调用方先用 `isTauri()` 判定，避免在浏览器里调到这里；万一调到了，
 * 也会先 throw 带「Tauri host」明示的错（`tauriInvoke` 在非 Tauri 环境
 * 会自己抛 "window.__TAURI_INTERNALS__ not defined"，但信息不如这个清楚）。
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { isTauri } from './tauri'

/**
 * 调 Rust 命令。**不会**自动降级 — 调用方应先用 isTauri() 判定。
 * - 不在 Tauri → throw with install hint，让调用方走 mic-only 分支
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error('invoke called outside Tauri host')
  }
  return tauriInvoke<T>(cmd, args)
}
