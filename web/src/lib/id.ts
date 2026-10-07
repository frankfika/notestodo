/**
 * 平台相关的修饰键符号：
 *   mac → ⌘
 *   其他 → ⌃
 * 用法：`<span>{mod()}K</span>` 让快捷键提示在 Mac/Win/Linux 上都正确。
 */
export function mod(): string {
  if (typeof navigator === 'undefined') return '⌘'
  return /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : '⌃'
}

export function uid(): string {
  return crypto.randomUUID()
}

export function now(): string {
  return new Date().toISOString()
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
}

export function fmtDate(iso: string | undefined, withYear = false): string {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  const md = `${p(d.getMonth() + 1)}月${p(d.getDate())}日`
  // 相对日期：今天/昨天/明天 — 人扫一眼比"10月07日"快一档。withYear 时不启用。
  const nowD = new Date()
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()).getTime()) / 86400000,
  )
  if (!withYear) {
    if (dayDiff === 0) return '今天'
    if (dayDiff === -1) return '昨天'
    if (dayDiff === 1) return '明天'
  }
  return withYear ? `${d.getFullYear()}年${md}` : md
}

export function fmtDateTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${fmtDate(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`
}
