/**
 * Tag 计数 bug 修复 e2e — 软删除 todo 时级联软删除 tagBindings
 *
 * 之前 bug：remove() 只把 todo.status 设 cancelled，但不动 tagBindings。
 * 结果：tagUsageCount 把已删 todo 的 binding 计入 → 过滤行显示「#tag 2」但只有 1 个活跃 todo。
 *
 * 修复：remove() 同时把所有 tagBindings.deleted_at 设为 now()（软删除）。
 * tagIdsByTodo 自然过滤掉 deleted_at != null 的 binding → 计数准确。
 *
 * 测试：
 *   1. Seed 1 tag + 2 todo（都绑这个 tag）
 *   2. 打开 TodosPage → 过滤行显示 #tag 2（先确认 bug 场景出现）
 *   3. UI 上删第二个 todo
 *   4. 重新渲染 → 过滤行显示 #tag 1（修复生效）
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('Tag 计数：删除 todo 时级联清理 tagBinding → 计数减一', async ({ page }) => {
  test.setTimeout(30_000)
  page.on('dialog', (dialog) => void dialog.accept()) // accept delete confirm

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // Seed: 1 tag + 2 todo + 2 active bindings（都指向 tag）
  const todo2Id = await page.evaluate(async () => {
    const tagId = crypto.randomUUID()
    const todo1Id = crypto.randomUUID()
    const todo2Id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['tags', 'todos', 'tagBindings'], 'readwrite')
        tx.objectStore('tags').put({
          id: tagId, name: 'counted', color: '#888',
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('todos').put({
          id: todo1Id, kind: 'task', parent_id: null, title: '保留的任务', status: 'open',
          source: 'manual', created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('todos').put({
          id: todo2Id, kind: 'task', parent_id: null, title: '将被删除的任务', status: 'open',
          source: 'manual', created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('tagBindings').put({
          id: crypto.randomUUID(), tag_id: tagId, target_type: 'todo', target_id: todo1Id,
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.objectStore('tagBindings').put({
          id: crypto.randomUUID(), tag_id: tagId, target_type: 'todo', target_id: todo2Id,
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return todo2Id
  })

  // 导航到 TodosPage
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goTodos: () => void } } }).__uiStore?.getState().goTodos())
  await page.waitForTimeout(600)

  // 1) 修复前/后对比：seed 后 chip 显示 #counted 2（修复 bug 触发条件）
  let chipText = await page.locator('button:has-text("#counted")').first().innerText()
  expect(chipText).toMatch(/2/) // bug 状态下应见 2

  // 2) 「将被删除的任务」的 ⋯ 菜单 → 删除
  const todoRow = page.locator('div.group:has-text("将被删除的任务")').first()
  await todoRow.scrollIntoViewIfNeeded()
  await todoRow.hover()
  await page.waitForTimeout(300)
  await todoRow.locator('button[aria-label="更多操作"]').first().click({ timeout: 8_000 })
  await page.getByRole('menuitem', { name: '删除' }).click()
  await page.waitForTimeout(1500)

  // 3) 修复后：chip 应显示 #counted 1
  chipText = await page.locator('button:has-text("#counted")').first().innerText()
  expect(chipText).toMatch(/1/) // 修复后只计 activeTodo
  expect(chipText).not.toMatch(/2/)

  // 4) 验证 DB: todo2 的 binding deleted_at !== null
  const bindingState = await page.evaluate(async (t2id) => new Promise<{ deleted: number; active: number }>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['tagBindings'], 'readonly')
      const all = tx.objectStore('tagBindings').getAll()
      all.onsuccess = () => {
        const arr = (all.result as Array<{ target_id: string; deleted_at: string | null }>).filter(
          (x) => x.target_id === t2id,
        )
        res({
          deleted: arr.filter((x) => x.deleted_at !== null).length,
          active: arr.filter((x) => x.deleted_at === null).length,
        })
      }
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }), todo2Id)
  expect(bindingState.deleted).toBe(1)
  expect(bindingState.active).toBe(0)
})