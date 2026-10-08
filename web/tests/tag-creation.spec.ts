/**
 * Tag 创建/绑定 e2e — 用户在 TodoRow 的「加标签」输入框里输入名字 + Enter，
 * 走 TagPicker.commit：找现有同名 tag（case-insensitive），或新建 tag，
 * 然后写 TagBinding。
 *
 * 需求 #3「可以充分发挥 tags」闭环：写标签 → DB 持久化。
 * （过滤行可见性由 round 21 的 tag 过滤 e2e 覆盖）
 *
 * 用 toBeAttached 而非 toBeVisible，因为 onboarding 卡片可能短暂遮挡。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('Tag 创建：TodoRow TagPicker 输入 → 新 tag + 绑定', async ({ page }) => {
  test.setTimeout(30_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800) // 等 bootstrap + UI store 完成
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // Seed：1 条 free task
  const todoId = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['todos'], 'readwrite')
        tx.objectStore('todos').put({
          id, kind: 'task', parent_id: null, title: 'Tag 创建测试任务', status: 'open',
          source: 'manual', created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })

  // 导航到 TodosPage
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goTodos: () => void } } }).__uiStore?.getState().goTodos())
  await page.waitForTimeout(600)

  // 1) Hover + click edit (EditPopover 打开)
  const todoRow = page.locator('div.group:has-text("Tag 创建测试任务")').first()
  await todoRow.scrollIntoViewIfNeeded()
  await todoRow.hover()
  await page.waitForTimeout(400)
  const editBtn = todoRow.locator('button[aria-label="编辑"]').first()
  await editBtn.click({ timeout: 8_000 })
  await page.waitForTimeout(1000)

  // 2) TagPicker input 出现（onboarding 卡片可能短暂遮挡，用 attached 而非 visible）
  const tagInput = page.locator('input[placeholder="加标签…"]').first()
  await expect(tagInput).toBeAttached({ timeout: 8_000 })

  // 3) 输入 "followup" → Enter → 应创建 tag + binding
  await tagInput.fill('followup')
  await tagInput.press('Enter')
  await page.waitForTimeout(600)

  // 4) TagPicker 渲染 #followup chip（含 ✕）
  const tagChip = page.locator('span.chip:has-text("#followup")').first()
  await expect(tagChip).toBeAttached({ timeout: 5_000 })

  // 5) DB 验证：tag 创建 + binding 写入
  const state = await page.evaluate(async (id) => new Promise<{
    tagName: string
    bindingTargetId: string | undefined
  }>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['tags', 'tagBindings'], 'readonly')
      const t = tx.objectStore('tags').getAll()
      const b = tx.objectStore('tagBindings').getAll()
      t.onsuccess = () => b.onsuccess = () => {
        const tags = t.result as Array<{ name: string }>
        const bindings = b.result as Array<{ target_id: string; tag_id: string; target_type: string; deleted_at: null | string }>
        const followup = tags.find((x) => x.name.toLowerCase() === 'followup')
        const followupBinding = bindings.find(
          (x) => x.target_id === id && x.target_type === 'todo' && x.deleted_at === null,
        )
        res({
          tagName: followup?.name ?? '',
          bindingTargetId: followupBinding?.target_id,
        })
      }
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }), todoId)

  expect(state.tagName).toBe('followup')
  expect(state.bindingTargetId).toBe(todoId)

  // 6) 再输入 "FollowUp"（同词不同大小写）→ 大小写不敏感，不重复创建
  await tagInput.fill('FollowUp')
  await tagInput.press('Enter')
  await page.waitForTimeout(500)

  const tags2 = await page.evaluate(async () => new Promise<number>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['tags'], 'readonly')
      const t = tx.objectStore('tags').getAll()
      t.onsuccess = () => res((t.result as Array<{ name: string }>).length)
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }))
  expect(tags2).toBe(1) // 大写不敏感：不创建新 tag，复用原来的 'followup'
})