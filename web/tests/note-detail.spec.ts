/**
 * 笔记详情页 e2e — 写作 + 插入待办 + 来源闭环（需求 #4）
 *
 * 流程：
 *   1. 创建笔记（种子数据）
 *   2. 进入笔记详情 → 看到标题输入框 + 块编辑器渲染
 *   3. 编辑标题/正文 → 400ms debounce 落库
 *   4. 点「+ 插入待办」→ 创建 origin_note_id 关联的 Todo
 *   5. 「关联任务」列表出现新 Todo
 *   6. 在 TodoPage 上能找到带 ✎ 来源标记的 todo — 验证需求 #4 闭环
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('笔记详情：编辑 + 插入待办 + 关联任务列表（笔记 ↔ 待办 闭环）', async ({ page }) => {
  test.setTimeout(45_000)
  page.setDefaultTimeout(15_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  const noteId = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['notes'], 'readwrite')
        tx.objectStore('notes').put({
          id,
          title: '原始标题',
          body_md: '# 标题\n\n原内容',
          pinned: false,
          todo_ids: [],
          created_at: nowIso,
          updated_at: nowIso,
          deleted_at: null,
          sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })

  // 导航到笔记详情
  await page.evaluate((id) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goNote: (id: string) => void } } }).__uiStore
    ui?.getState().goNote(id)
  }, noteId)
  await page.waitForTimeout(600)

  // 1) 笔记详情页加载：标题输入框 + 块编辑器（TipTap，所见即所得渲染 body_md）
  const titleInput = page.locator('input[placeholder="无标题"]').first()
  await expect(titleInput).toBeVisible({ timeout: 5000 })
  await expect(titleInput).toHaveValue('原始标题')
  const ed = page.locator('.note-editor .ProseMirror').first()
  await expect(ed).toBeVisible()
  await expect(ed.locator('h1')).toHaveText('标题')
  await expect(ed).toContainText('原内容')

  // 2) 修改标题与正文（全选重写：标题 + 两段）
  await titleInput.fill('E2E 笔记 - 已编辑')
  await ed.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.type('# 新标题')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('这是从 e2e 写入的正文。')
  await page.waitForTimeout(800) // 等 debounce 400ms

  // 3) 校验：DB 中 title / body_md 已被 debounce 落库
  const updated = await page.evaluate(async (id) => new Promise<{ title: string; body_md: string }>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['notes'], 'readonly')
      const n = tx.objectStore('notes').get(id)
      n.onsuccess = () => res({ title: (n.result as { title: string }).title, body_md: (n.result as { body_md: string }).body_md })
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }), noteId)
  expect(updated.title).toBe('E2E 笔记 - 已编辑')
  expect(updated.body_md).toContain('# 新标题')
  expect(updated.body_md).toContain('这是从 e2e 写入的正文。')

  // 4) 点「+ 插入待办」→ 创建一个关联任务
  await page.getByRole('button', { name: '+ 插入待办' }).click()
  await page.waitForTimeout(500)

  // 5) 关联任务列表渲染这条 todo — section title 含 (1) 表明 linkedTodos.length === 1
  const sectionTitle = page.locator('.section-title:has-text("从这条笔记创建的任务")')
  await expect(sectionTitle).toContainText('(1)', { timeout: 5_000 })
  // todo 元素 — 标题是 '从笔记创建的任务'（无「这条」）
  await expect(page.locator('li:has-text("从笔记创建的任务")').first()).toBeVisible()

  // 6) DB 中 todo.origin_note_id 正确链接，note.todo_ids 含这条 id
  const link = await page.evaluate(async (id) => new Promise<{
    todoCount: number
    todoOriginId: string | undefined
    noteTodoIds: string[]
  }>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['notes', 'todos'], 'readonly')
      const n = tx.objectStore('notes').get(id)
      const t = tx.objectStore('todos').getAll()
      n.onsuccess = () =>
        t.onsuccess = () => {
          const note = n.result as { todo_ids?: string[] }
          const todos = t.result as Array<{ origin_note_id?: string }>
          const linked = todos.filter((x) => x.origin_note_id === id)
          res({
            todoCount: linked.length,
            todoOriginId: linked[0]?.origin_note_id,
            noteTodoIds: note?.todo_ids ?? [],
          })
        }
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }), noteId)

  expect(link.todoCount).toBe(1)
  expect(link.todoOriginId).toBe(noteId)
  expect(link.noteTodoIds.length).toBe(1)

  // 7) 切到「待办」页 → 该任务带 ✎ 来源标记（需求 #4 闭环）
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goTodos: () => void } } }).__uiStore?.getState().goTodos())
  await page.waitForTimeout(500)
  // ✎ 来源按钮
  const noteLinkBtn = page.getByRole('button').filter({ hasText: /✎/ }).first()
  await expect(noteLinkBtn).toBeVisible({ timeout: 5000 })
})