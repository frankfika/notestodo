import { test, expect } from '@playwright/test'
import { mergeHotwords } from '../src/lib/hotwords'

test('mergeHotwords：多种分隔符、去重、去 @、跳过长句与默认标题、上限 40', () => {
  expect(mergeHotwords('张三，李四\nPoC、方案B', ['@李四', '王五'], undefined, '会议 · 2026-10-17 10:00'))
    .toEqual(['张三', '李四', 'PoC', '方案B', '王五'])
  expect(mergeHotwords(['这是一整句话而不是一个热词所以应当被跳过'])).toEqual([])
  expect(mergeHotwords(Array.from({ length: 100 }, (_, i) => `词${i}`))).toHaveLength(40)
})
