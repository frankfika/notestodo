/**
 * 快速录入解析：「周五前交方案 @张三」→ { title: '交方案', due_date: 周五, assignee: '张三' }
 * 支持：今天 / 明天 / 后天 / [下]周一…周日(前) / M月D日 / M-D / M/D；@姓名。
 * ponytail: 只认这几种常见写法，够用；要「下个月底」这类再上 LLM 解析。
 */
export interface QuickAdd { title: string; due_date?: string; assignee?: string }

const WD: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function parseQuickAdd(input: string, base = new Date()): QuickAdd {
  let text = ` ${input} `
  let due: Date | undefined
  let assignee: string | undefined

  text = text.replace(/\s@([^\s@]+)/, (_, n: string) => { assignee = n; return ' ' })

  const day = (offset: number): Date => new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
  const rules: [RegExp, (m: RegExpMatchArray) => Date | undefined][] = [
    [/(今天|今日)(之前|前)?/, () => day(0)],
    [/明天(之前|前)?/, () => day(1)],
    [/后天(之前|前)?/, () => day(2)],
    [/(下)?(?:周|星期|礼拜)([一二三四五六日天])(之前|前)?/, (m) => {
      const target = WD[m[2]]
      // 本周X：周一为一周起点；已过则仍取本周（逾期），「下周X」再 +7
      const cur = (base.getDay() + 6) % 7
      const want = (target + 6) % 7
      return day(want - cur + (m[1] ? 7 : 0))
    }],
    [/(\d{1,2})月(\d{1,2})[日号]?(之前|前)?/, (m) => monthDay(+m[1], +m[2])],
    [/(?<![\d.])(\d{1,2})[-/](\d{1,2})(?![\d])(之前|前)?/, (m) => monthDay(+m[1], +m[2])],
  ]
  function monthDay(mo: number, d: number): Date | undefined {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined
    const dt = new Date(base.getFullYear(), mo - 1, d)
    // 已过去超过 2 个月的日期视为明年（12 月录「1/5」）
    if (dt.getTime() < day(-60).getTime()) dt.setFullYear(dt.getFullYear() + 1)
    return dt
  }
  for (const [re, fn] of rules) {
    const m = text.match(re)
    if (!m) continue
    const d = fn(m)
    if (!d) continue
    due = d
    text = text.replace(re, ' ')
    break
  }

  const title = text.replace(/\s+/g, ' ').trim()
  return { title: title || input.trim(), due_date: due && iso(due), assignee }
}
