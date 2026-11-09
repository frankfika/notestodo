/**
 * 「先删 + 可撤销」的还原能力 e2e
 *
 * 破坏性操作改成可撤销后，最关键的不是提示条长什么样，而是**撤销真的能把数据还原**。
 * 逐个验证：
 *   1. 删标签 → 撤销 → 标签 + N 处引用绑定都回来
 *   2. 删笔记 → 撤销 → 笔记回来、子页挂回原来的父级
 *   3. 删看板 → 撤销 → 看板回来、卡片挂回原看板
 *   4. 清空对话 → 撤销 → 对话消息原样回来
 *   5. 导入失败 → 自动回滚 → 数据不变 + toast 告知
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function boot(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()
}

test('标签删除撤销：引用计数回到删除前', async ({ page }) => {
  test.setTimeout(45_000)
  await boot(page)
  await page.evaluate(async () => {
    const nowIso = new Date().toISOString()
    const tagId = crypto.randomUUID()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['tags', 'todos', 'tagBindings'], 'readwrite')
        tx.objectStore('tags').put({ id: tagId, name: 'undotest', color: '#888', created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0 })
        for (let i = 0; i < 2; i++) {
          const todoId = crypto.randomUUID()
          tx.objectStore('todos').put({ id: todoId, kind: 'task', parent_id: null, title: `t${i}`, status: 'open', source: 'manual', sort_order: 0, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0 })
          tx.objectStore('tagBindings').put({ id: crypto.randomUUID(), tag_id: tagId, target_type: 'todo', target_id: todoId, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0 })
        }
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
  })
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goSettings: () => void } } }).__uiStore?.getState().goSettings())
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: '外观与数据' }).click()
  await page.waitForTimeout(400)
  // 外部 IndexedDB 写入不会刷新运行中的 liveQuery —— reload 让 app 带着种子数据重启
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goSettings: () => void } } }).__uiStore?.getState().goSettings())
  await page.waitForTimeout(500)
  await page.getByRole('button', { name: '外观与数据' }).click()
  await page.waitForTimeout(600)

  const nameInput = page.locator('input[value="undotest"]')
  await expect(nameInput).toBeAttached()
  await expect(page.getByText('2 处引用').first()).toBeAttached()

  await page.locator('button[title="删除标签"]').first().click({ force: true })
  await page.waitForTimeout(700)
  expect(await page.getByText('2 处引用').count()).toBe(0)

  await page.getByRole('button', { name: '撤销' }).first().click({ timeout: 5000 })
  await page.waitForTimeout(800)
  await expect(page.locator('input[value="undotest"]')).toBeAttached()
  await expect(page.getByText('2 处引用').first()).toBeAttached()

  const dbState = await page.evaluate(async () => new Promise<{ tags: number; binds: number }>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['tags', 'tagBindings'], 'readonly')
      const t = tx.objectStore('tags').count()
      const b = tx.objectStore('tagBindings').count()
      t.onsuccess = () => { b.onsuccess = () => res({ tags: t.result, binds: b.result }); b.onerror = () => rej(b.error) }
      t.onerror = () => rej(t.error)
    }
    req.onerror = () => rej(new Error('idxb'))
  }))
  expect(dbState.tags).toBe(1)
  expect(dbState.binds).toBe(2)
})

test('笔记删除撤销：笔记回来 + 子页挂回原位', async ({ page }) => {
  test.setTimeout(45_000)
  await boot(page)
  const ids = await page.evaluate(async () => {
    const nowIso = new Date().toISOString()
    const parentId = crypto.randomUUID()
    const childId = crypto.randomUUID()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['notes'], 'readwrite')
        tx.objectStore('notes').put({ id: parentId, title: '父页', body_md: '', todo_ids: [], pinned: false, parent_id: null, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0 })
        tx.objectStore('notes').put({ id: childId, title: '子页', body_md: '', todo_ids: [], pinned: false, parent_id: parentId, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0 })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return { parentId, childId }
  })

  await page.evaluate((id) => (window as unknown as { __uiStore?: { getState: () => { goNote: (id: string) => void } } }).__uiStore?.getState().goNote(id), ids.parentId)
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: '更多' }).click()
  await page.getByRole('button', { name: '删除笔记' }).click()
  await page.waitForTimeout(800)

  const readChild = async (): Promise<string | null> => page.evaluate(async (cid) => new Promise<string | null>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['notes'], 'readonly')
      const g = tx.objectStore('notes').get(cid)
      g.onsuccess = () => res(g.result ? (g.result.parent_id ?? null) : null)
      g.onerror = () => rej(g.error)
    }
    req.onerror = () => rej(new Error('idxb'))
  }), ids.childId)

  // 子页上移一层
  expect(await readChild()).toBeNull()

  await page.getByRole('button', { name: '撤销' }).first().click({ timeout: 5000 })
  await page.waitForTimeout(900)
  expect(await readChild()).toBe(ids.parentId)

  const parentAlive = await page.evaluate(async (pid) => new Promise<boolean>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['notes'], 'readonly')
      const g = tx.objectStore('notes').get(pid)
      g.onsuccess = () => res(!!g.result && g.result.deleted_at === null)
      g.onerror = () => rej(g.error)
    }
    req.onerror = () => rej(new Error('idxb'))
  }), ids.parentId)
  expect(parentAlive).toBe(true)
})

test('看板 / 列删除撤销：看板回来、卡片回到原列', async ({ page }) => {
  test.setTimeout(45_000)
  await boot(page)
  const boardId = await page.evaluate(async () => {
    const nowIso = new Date().toISOString()
    const bid = crypto.randomUUID()
    const todoId = crypto.randomUUID()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['boards', 'todos'], 'readwrite')
        tx.objectStore('boards').put({ id: bid, name: '撤销看板', icon: '📋', columns: ['待办', '进行中'], sort_order: 9, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0 })
        tx.objectStore('todos').put({ id: todoId, kind: 'task', parent_id: null, title: '看板卡片', status: 'open', source: 'manual', board_id: bid, board_col: '进行中', sort_order: 0, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0 })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return bid
  })
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goBoard: () => void } } }).__uiStore?.getState().goBoard())
  await page.waitForTimeout(900)

  const readCard = async (): Promise<{ board: string | null; col: string | undefined }> => page.evaluate(async () => new Promise((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['todos'], 'readonly')
      const g = tx.objectStore('todos').getAll()
      g.onsuccess = () => {
        const t = (g.result as Array<{ title: string; board_id?: string | null; board_col?: string }>).find((x) => x.title === '看板卡片')
        res({ board: t?.board_id ?? null, col: t?.board_col })
      }
      g.onerror = () => rej(g.error)
    }
    req.onerror = () => rej(new Error('idxb'))
  }))

  // 找到「撤销看板」这个 chip，点它右边的 ⋯ 菜单
  const chip = page.getByText('📋 撤销看板')
  await chip.click()
  await page.waitForTimeout(500)
  await chip.locator('xpath=..').locator('button[title="更多操作"]').click({ force: true })
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: '删除看板' }).click()
  await page.waitForTimeout(900)

  expect((await readCard()).board).toBeNull()

  await page.getByRole('button', { name: '撤销' }).first().click({ timeout: 5000 })
  await page.waitForTimeout(900)
  expect((await readCard()).board).toBe(boardId)
})

test('清空对话撤销：消息回来', async ({ page }) => {
  test.setTimeout(45_000)
  await boot(page)
  const meetingId = await page.evaluate(async () => {
    const nowIso = new Date().toISOString()
    const mid = crypto.randomUUID()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'chatMessages'], 'readwrite')
        tx.objectStore('meetings').put({ id: mid, title: '对话会议', status: 'summarized', source: 'manual', started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0, audio: { format: 'audio/webm', codec: 'opus', duration_ms: 1000, chunk_count: 0, size_bytes: 0, gaps: [] } })
        for (let i = 0; i < 3; i++) {
          tx.objectStore('chatMessages').put({ id: crypto.randomUUID(), meeting_id: mid, role: i % 2 ? 'assistant' : 'user', content: `msg${i}`, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0 })
        }
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return mid
  })
  await page.evaluate((id) => (window as unknown as { __uiStore?: { getState: () => { goMeeting: (id: string) => void } } }).__uiStore?.getState().goMeeting(id), meetingId)
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: '对话' }).click()
  await page.waitForTimeout(600)

  const countMsgs = async (): Promise<number> => page.evaluate(async (id) => new Promise<number>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['chatMessages'], 'readonly')
      const c = tx.objectStore('chatMessages').index('meeting_id').count(IDBKeyRange.only(id))
      c.onsuccess = () => res(c.result)
      c.onerror = () => rej(c.error)
    }
    req.onerror = () => rej(new Error('idxb'))
  }), meetingId)

  expect(await countMsgs()).toBe(3)
  await page.getByRole('button', { name: '清空' }).click()
  await page.waitForTimeout(700)
  expect(await countMsgs()).toBe(0)

  await page.getByRole('button', { name: '撤销' }).first().click({ timeout: 5000 })
  await page.waitForTimeout(800)
  expect(await countMsgs()).toBe(3)
})

test('导入失败自动回滚：数据不变 + toast 告知', async ({ page }) => {
  test.setTimeout(45_000)
  await boot(page)
  await page.evaluate(async () => {
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['notes'], 'readwrite')
        tx.objectStore('notes').put({ id: crypto.randomUUID(), title: '导入前笔记', body_md: '', todo_ids: [], pinned: false, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0 })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
  })
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goSettings: () => void } } }).__uiStore?.getState().goSettings())
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: '外观与数据' }).click()
  await page.waitForTimeout(400)

  const countNotes = async (): Promise<number> => page.evaluate(async () => new Promise<number>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['notes'], 'readonly')
      const c = tx.objectStore('notes').count()
      c.onsuccess = () => res(c.result)
      c.onerror = () => rej(c.error)
    }
    req.onerror = () => rej(new Error('idxb'))
  }))

  const before = await countNotes()
  // 造一个坏 zip（不是合法 zip）→ importData 抛错
  await page.setInputFiles('input[type="file"]', {
    name: 'bad.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('this is not a zip'),
  })
  await page.waitForTimeout(2500)
  expect(await countNotes()).toBe(before)
  await expect(page.getByText('导入失败，数据已回滚').first()).toBeAttached()
})
