import { test, expect } from '@playwright/test'
import { parseQuickAdd } from '../src/lib/quickAdd'

// 2026-10-15 是周四
const base = new Date(2026, 9, 15)

test('quickAdd：相对日期 + @负责人', () => {
  expect(parseQuickAdd('明天 交方案 @张三', base)).toEqual({ title: '交方案', due_date: '2026-10-16', assignee: '张三' })
  expect(parseQuickAdd('周五前交方案', base)).toEqual({ title: '交方案', due_date: '2026-10-16', assignee: undefined })
  expect(parseQuickAdd('下周一 复盘', base).due_date).toBe('2026-10-19')
  expect(parseQuickAdd('周一 复盘', base).due_date).toBe('2026-10-12')
  expect(parseQuickAdd('后天发版', base)).toMatchObject({ title: '发版', due_date: '2026-10-17' })
})

test('quickAdd：绝对日期，跨年，不误伤版本号', () => {
  expect(parseQuickAdd('10月20日 评审', base).due_date).toBe('2026-10-20')
  expect(parseQuickAdd('评审 11/3', base).due_date).toBe('2026-11-03')
  expect(parseQuickAdd('1/5 年度规划', new Date(2026, 11, 20)).due_date).toBe('2027-01-05')
  expect(parseQuickAdd('升级到 v1.2.3', base)).toEqual({ title: '升级到 v1.2.3', due_date: undefined, assignee: undefined })
  expect(parseQuickAdd('只有标题', base)).toEqual({ title: '只有标题', due_date: undefined, assignee: undefined })
})
