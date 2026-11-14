import { expect, test } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function bootNotes(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const now = new Date().toISOString()
    await db.kv.put({ key: 'onboarding_done_v1', value: true })
    await db.notes.clear()
    await db.notebooks.clear()
    await db.tags.clear()
    await db.tagBindings.clear()

    await db.notebooks.bulkPut([
      { id: 'nb-legal', name: '法务库', icon: '⚖️', sort_order: 1, created_at: now, updated_at: now, deleted_at: null, sync_version: 0 },
    ])
    await db.tags.bulkPut([
      { id: 'tag-contract', name: '合同', color: '#999999', created_at: now, updated_at: now, deleted_at: null, sync_version: 0 },
    ])
    await db.notes.bulkPut([
      {
        id: 'note-legal',
        title: '供应商合同复盘',
        body_md: '重点检查付款条款和违约责任。',
        todo_ids: [],
        pinned: true,
        parent_id: null,
        notebook_id: 'nb-legal',
        created_at: now,
        updated_at: now,
        deleted_at: null,
        sync_version: 0,
      },
      {
        id: 'note-product',
        title: '产品路线',
        body_md: '下个版本先把搜索和归档做扎实。',
        todo_ids: [],
        pinned: false,
        parent_id: null,
        notebook_id: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        sync_version: 0,
      },
      {
        id: 'note-meeting',
        title: '周会纪要',
        body_md: '这周要把合同方案发出去。',
        meeting_id: 'meeting-1',
        todo_ids: [],
        pinned: false,
        parent_id: null,
        notebook_id: null,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        sync_version: 0,
      },
    ])
    await db.tagBindings.bulkPut([
      {
        id: 'bind-contract',
        tag_id: 'tag-contract',
        target_type: 'note',
        target_id: 'note-legal',
        created_at: now,
        updated_at: now,
        deleted_at: null,
        sync_version: 0,
      },
    ])
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goNotes: () => void } } }).__uiStore?.getState().goNotes())
  await page.waitForTimeout(500)
}

test('Notes 提供搜索和范围筛选，笔记多了也能快速找回', async ({ page }) => {
  await bootNotes(page)

  const searchInput = page.getByPlaceholder('搜索标题、正文、笔记本或标签')
  const main = page.locator('main')
  await expect(searchInput).toBeVisible()

  await searchInput.fill('合同')
  await expect(main.getByRole('button', { name: /供应商合同复盘/ })).toBeVisible()
  await expect(main.getByRole('button', { name: /产品路线/ })).toHaveCount(0)

  await page.getByRole('button', { name: '会议纪要' }).click()
  await expect(main.getByRole('button', { name: /周会纪要/ })).toBeVisible()
  await expect(main.getByRole('button', { name: /供应商合同复盘/ })).toHaveCount(0)
})

test('侧栏页面树支持快速搜索页面并直接打开', async ({ page }) => {
  await bootNotes(page)

  const treeSearch = page.locator('aside').getByPlaceholder('搜页面…')
  await expect(treeSearch).toBeVisible()
  await treeSearch.fill('产品')

  await page.locator('aside').getByRole('button', { name: /产品路线/ }).click()
  await expect(page.locator('main input').first()).toHaveValue('产品路线')
})
