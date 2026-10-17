import { test, expect } from '@playwright/test'
import { tidyEmptySections } from '../src/pipeline/summarize'

test('tidyEmptySections：把 "[]" 整行替换为「无」', () => {
  expect(tidyEmptySections('[]')).toBe('无')
  // 行内空白也归一为「无」
  expect(tidyEmptySections('  []  ')).toBe('无')
})

test('tidyEmptySections：把 "- []" / "* {}" 这类 bullet 也归一为「无」', () => {
  expect(tidyEmptySections('- []')).toBe('无')
  expect(tidyEmptySections('* {}')).toBe('无')
  // 多余的前导空格也不算事
  expect(tidyEmptySections('  - []')).toBe('无')
})

test('tidyEmptySections：正常行一律原样保留', () => {
  const md = [
    '## 决定',
    '- 决定 A',
    '- 决定 B',
    '',
    '## 行动项',
    '- [ ] 待办 1',
    '- 一些说明：保留 [] 与 {} 这类文本',
    '- 涉及版本号 v1.2.3 也不要动',
  ].join('\n')
  expect(tidyEmptySections(md)).toBe(md)
})
