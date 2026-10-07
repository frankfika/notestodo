/** URL 拼接：去掉 base 尾部斜杠 + 保证 path 以 / 开头 */
export function joinUrl(base: string, path: string): string {
  const b = (base || '').replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}
