/**
 * Tauri 2 invoke() 的薄封装 + 浏览器降级。
 *
 * 在 web build 里根本没有 @tauri-apps/api；即使装了 dynamic import，
 * 浏览器也没有 window.__TAURI_INTERNALS__，会抛 not in Tauri context。
 * 这里把所有调用都收口成「先检测 host，失败时抛有意义错」 — 调用方用
 * isTauri() 判断是否值得调，无需各自 try/catch。
 *
 * @tauri-apps/api 在 Phase-1 没装（只有 @tauri-apps/cli），靠 dynamic import
 * + try/catch 在 Tauri host 内才走真实调用，web build / 未来未装包时失败
 * 抛带 install hint 的 Error。
 *
 * 实现细节：必须把 import 字符串藏在 new Function(...) 里，否则 Vite
 * 的 import-analysis 会在 dev/build 时静态解析这个 specifier 并报错
 * （即便有 vite-ignore 注释，某些 Vite 版本仍会触发）。Function 形式
 * 跳过静态分析，仅运行时解析。
 */

import { isTauri } from './tauri'

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

let cached: InvokeFn | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynamicImport: (s: string) => Promise<any> = (() => {
  // new Function 让 Vite/Rollup 的 import-analysis 跳过这个 specifier
  // 用字符串拼接避免 TS/lint 把 import 当关键字拒绝
  if (typeof Function !== 'function') {
    return (s) => import(s)
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const f = new Function('s', 'return ' + 'import(s)')
  return f as (s: string) => Promise<unknown>
})()

async function load(): Promise<InvokeFn> {
  if (cached) return cached
  // 仅在 Tauri 内才尝试 dynamic import；浏览器里直接抛。
  if (!isTauri()) {
    throw new Error('invoke called outside Tauri host')
  }
  try {
    const mod = (await dynamicImport('@tauri-apps/api/core')) as { invoke: InvokeFn }
    cached = mod.invoke
    return cached
  } catch (e) {
    throw new Error(
      'Tauri host detected but @tauri-apps/api is not installed. ' +
        'Run "pnpm add @tauri-apps/api" in web/ to enable Rust <-> JS calls. ' +
        'Underlying: ' + (e instanceof Error ? e.message : String(e)),
    )
  }
}

/**
 * 调 Rust 命令。**不会**自动降级；调用方必须先用 isTauri() 判定。
 * - 不在 Tauri -> throw（让调用方走 mic-only 分支）
 * - 装了 Tauri 但没装 @tauri-apps/api -> throw with install hint
 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const fn = await load()
  return fn<T>(cmd, args)
}
