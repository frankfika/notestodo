/**
 * Obsidian 风格借鉴：[[双链]]（按标题解析、点击跳转、断链虚线提示）+
 * Markdown vault 导出（笔记 → 带 frontmatter 的 .md，任务 → 嵌套 GFM 任务列表）。
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function seed(page: Page): Promise<void> {
  await page.goto(BASE)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.kv.put({ key: 'onboarding_done_v1', value: true })
    await db.notes.clear()
    await db.todos.clear()
    const ts = new Date().toISOString()
    await db.notes.bulkPut([
      { id: 'n1', title: '会议纪要', body_md: '见 [[复盘方法|这篇]] 和 [[不存在的笔记]]', todo_ids: [], pinned: false, created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 },
      { id: 'n2', title: '复盘方法', body_md: '# 怎么复盘\n- 对照目标', todo_ids: [], pinned: false, created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 },
    ])
    await db.todos.bulkPut([
      { id: 'O', kind: 'objective', scope: 'strategic', parent_id: null, title: '战略 O', status: 'open', source: 'manual', sort_order: 10, created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 },
      { id: 'K', kind: 'kr', scope: 'strategic', parent_id: 'O', title: 'KR 甲', status: 'open', source: 'manual', sort_order: 20, created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 },
      { id: 't1', kind: 'task', scope: 'strategic', parent_id: 'K', title: '写周报', status: 'done', source: 'manual', due_date: '2026-10-30', sort_order: 30, created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 },
      { id: 't2', kind: 'task', scope: null, parent_id: null, title: '买牛奶', status: 'open', source: 'manual', sort_order: 40, created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 },
      { id: 'gone', kind: 'task', scope: null, parent_id: null, title: '已删除', status: 'open', source: 'manual', sort_order: 50, created_at: ts, updated_at: ts, deleted_at: ts, sync_version: 0 },
    ])
    ;(window as unknown as { __uiStore: { getState: () => { goNote: (id: string) => void } } }).__uiStore.getState().goNote('n1')
  })
}

test('[[双链]]：命中渲染成按钮并跳转；断链虚线提示', async ({ page }) => {
  await seed(page)
  // 预览里的双链按钮（含别名显示「这篇」）
  const link = page.locator('button', { hasText: '这篇' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('title', '打开笔记「复盘方法」')
  // 断链：虚线 span，带提示
  await expect(page.locator('span[title="还没有叫「不存在的笔记」的笔记"]')).toBeVisible()
  // 点击跳转 → 标题输入框变成复盘方法
  await link.click()
  await expect(page.locator('input[placeholder="标题"]')).toHaveValue('复盘方法')
})

test('Markdown 导出：笔记带 frontmatter、任务成嵌套 GFM 列表、软删不出现', async ({ page }) => {
  await seed(page)
  const out = await page.evaluate(async () => {
    const { buildMarkdownZip, unzipSync, strFromU8 } = await import('/src/data/mdExport.ts')
    const { db } = await import('/src/db/db.ts')
    const zip = buildMarkdownZip(await db.notes.toArray(), await db.todos.toArray())
    const files = unzipSync(zip)
    return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]))
  })
  const names = Object.keys(out)
  expect(names).toContain('会议纪要.md')
  expect(names).toContain('复盘方法.md')
  expect(names).toContain('拾贝任务.md')
  // frontmatter 保留 id / 时间戳 + 正文
  expect(out['复盘方法.md']).toContain('shibei_id: n2')
  expect(out['复盘方法.md']).toContain('title: "复盘方法"')
  expect(out['复盘方法.md']).toContain('# 怎么复盘')
  // 任务：嵌套 + 勾选态 + 截止 + 软删除不出现
  const tasks = out['拾贝任务.md']
  expect(tasks).toContain('- [ ] 战略 O')
  expect(tasks).toContain('  - [ ] KR 甲')
  expect(tasks).toContain('    - [x] 写周报 📅 2026-10-30')
  expect(tasks).toContain('- [ ] 买牛奶')
  expect(tasks).not.toContain('已删除')
})
