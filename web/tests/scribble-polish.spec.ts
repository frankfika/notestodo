import { test, expect } from '@playwright/test'
import { scribblesToMarkdown, buildPolishMessages, POLISH_SYSTEM } from '../src/llm/prompts'
import type { Meeting, Transcript } from '../src/types'

const meeting = {
  id: 'm1', title: '产品评审会', status: 'summarized', source: 'manual',
  started_at: '2026-10-14T06:00:00.000Z',
  audio: { format: 'audio/webm', codec: 'opus', duration_ms: 2533000, chunk_count: 3, size_bytes: 1, gaps: [] },
  note_id: 'n1', created_at: '', updated_at: '', deleted_at: null, sync_version: 0,
} as unknown as Meeting

const transcript = {
  id: 't1', meeting_id: 'm1', language: 'zh', engine: 'x', speaker_names: {},
  segments: [{ start_ms: 11000, end_ms: 15000, speaker_label: '说话人 1', text: 'ship date 定在下月' }],
  created_at: '', updated_at: '', deleted_at: null, sync_version: 0,
} as unknown as Transcript

test('scribblesToMarkdown：有时间锚点加 [MM:SS] 前缀，空行跳过，无锚点裸 bullet', () => {
  const md = scribblesToMarkdown([
    { t_ms: 3000, text: 'q4 预算 ??' },
    { t_ms: 11000, text: '  ship date 风险  ' },
    { t_ms: 5000, text: '   ' },
    { t_ms: null, text: '会后补记' },
  ])
  expect(md).toBe('- [00:03] q4 预算 ??\n- [00:11] ship date 风险\n- 会后补记')
})

test('buildPolishMessages：system 为 POLISH_SYSTEM，user 内嵌速记与转录两个 XML 块', () => {
  const scribbleMd = scribblesToMarkdown([{ t_ms: 11000, text: 'ship date 风险' }])
  const msgs = buildPolishMessages(meeting, scribbleMd, transcript)
  expect(msgs).toHaveLength(2)
  expect(msgs[0]).toEqual({ role: 'system', content: POLISH_SYSTEM })
  const user = msgs[1].content
  expect(user).toContain('产品评审会')
  expect(user).toContain('<scribble>\n- [00:11] ship date 风险\n</scribble>')
  expect(user).toContain('ship date 定在下月') // 转录原文进了 <transcript> 块
})

test('buildPolishMessages：无速记时给出兜底提示，无转录时标注（无转录）', () => {
  const noScribble = buildPolishMessages(meeting, '', undefined)[1].content
  expect(noScribble).toContain('用户没有记速记')
  expect(noScribble).toContain('（无转录）')
})
