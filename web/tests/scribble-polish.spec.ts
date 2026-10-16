import { test, expect } from '@playwright/test'
import { parseTimeHint, scribbleBlock, scribblesToMarkdown } from '../src/llm/prompts'

test('scribblesToMarkdown：有时间锚点加 [MM:SS] 前缀，空行跳过，无锚点裸 bullet', () => {
  const md = scribblesToMarkdown([
    { t_ms: 3000, text: 'q4 预算 ??' },
    { t_ms: 11000, text: '  ship date 风险  ' },
    { t_ms: 5000, text: '   ' },
    { t_ms: null, text: '会后补记' },
  ])
  expect(md).toBe('- [00:03] q4 预算 ??\n- [00:11] ship date 风险\n- 会后补记')
})

test('scribbleBlock：速记作为 <scribble> 骨架附在模板 prompt 后；无速记返回空串', () => {
  const md = scribblesToMarkdown([{ t_ms: 11000, text: 'ship date 风险' }])
  expect(scribbleBlock(md)).toContain('<scribble>\n- [00:11] ship date 风险\n</scribble>')
  expect(scribbleBlock('  ')).toBe('')
})

test('parseTimeHint：mm:ss / hh:mm:ss / 毫秒数 → 毫秒；无法解析为 undefined', () => {
  expect(parseTimeHint('00:11')).toBe(11_000)
  expect(parseTimeHint('01:02:03')).toBe(3_723_000)
  expect(parseTimeHint(4500)).toBe(4500)
  expect(parseTimeHint('不知道')).toBeUndefined()
})
