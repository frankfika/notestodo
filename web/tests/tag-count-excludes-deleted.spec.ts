/**
 * Tag 计数语义 e2e — 删除任务时级联清理 tagBinding → 计数减一
 *
 * 历史背景：曾因 remove() 不清理 tagBindings 导致 tagUsageCount 把已删
 * todo 的 binding 计入。现在的实现（todoRowOps.softDeleteTree）在删除任务
 * 子树时直接硬删对应 tagBindings（where('[target_type+target_id]').delete()），
 * 「删除任务后 tag 计数减一」的语义仍然成立。
 *
 * 断言路径按当前 UI：
 *   - 计数展示在 设置 → 外观与数据 → 标签（TagManager「N 处引用」），
 *     任务页的 tag 过滤 chip 已移除。
 *   - 删除入口在任务树行的 ⋯ 菜单（title="更多操作"）→ 删除（confirm 自动接受）。
 *
 * 测试：
 *   1. Seed 1 tag + 2 todo（都绑这个 tag）→ reload（外部写库需要重启才进 liveQuery）
 *   2. TagManager 显示 #counted 2 处引用
 *   3. UI 上删第二个 todo（⋯ 菜单）
 *   4. TagManager 显示 1 处引用；DB 中 todo2 的 binding 已被硬删（0 行）
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function gotoTagManager(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('aside').getByRole('button', { name: '设置' }).click()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: '外观与数据' }).click()
  await page.waitForTimeout(300)
}

test('Tag 计数：删除 todo 时级联清理 tagBinding → 计数减一', async ({ page }) => {
  test.setTimeout(45_000)
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

  // 外部 IndexedDB 写入不会刷新运行中的 liveQuery — reload 让 app 带着种子数据重启
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  const x2 = page.locator('button[aria-label="关闭"]').first()
  if (await x2.isVisible({ timeout: 1500 }).catch(() => false)) await x2.click()

  // 1) TagManager：#counted 显示 2 处引用（bug 场景出现：两个活跃绑定）
  await gotoTagManager(page)
  await expect(page.getByText('2 处引用')).toBeVisible({ timeout: 5_000 })

  // 2) 任务树 →「将被删除的任务」的 ⋯ 菜单 → 删除
  await page.locator('aside nav').getByRole('button', { name: '任务' }).click()
  await page.waitForTimeout(500)
  const todoRow = page.locator('div[data-todo]:has-text("将被删除的任务")').first()
  await todoRow.scrollIntoViewIfNeeded()
  await todoRow.hover()
  await page.waitForTimeout(300)
  await todoRow.locator('button[title="更多操作"]').click({ timeout: 8_000 })
  await todoRow.getByText('删除', { exact: true }).click()
  await page.waitForTimeout(1000) // confirm 已自动接受，软删子树 + 硬删 bindings

  // 3) 修复后：#counted 只剩 1 处引用
  await gotoTagManager(page)
  await expect(page.getByText('1 处引用')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText('2 处引用')).toHaveCount(0)

  // 4) 验证 DB: todo2 的 binding 已被硬删（当前实现是 delete，不是软删标记）
  const bindingCount = await page.evaluate(async (t2id) => new Promise<number>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['tagBindings'], 'readonly')
      const all = tx.objectStore('tagBindings').getAll()
      all.onsuccess = () => {
        res((all.result as Array<{ target_id: string }>).filter((x) => x.target_id === t2id).length)
      }
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }), todo2Id)
  expect(bindingCount).toBe(0)
})
