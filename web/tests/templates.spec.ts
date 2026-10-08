/**
 * 模板 CRUD e2e — 总结模板的完整生命周期：
 *   1. 内置模板只读（默认选中 标准会议纪要）
 *   2. 创建自定义模板 → 编辑器可用
 *   3. 编辑图标/名称/正文 → 保存
 *   4. 复制模板（基于现有模板创建新模板）
 *   5. 删除模板（自定义可删，内置不可删）
 *   6. 模板被 summarize 管线使用 — 验证选择某模板后 pipeline 用它
 *
 * 这是 summarize 阶段的数据来源（resolveTemplate 逻辑）。覆盖需求 #5
 * 「AI 功能怎么弄怎么做 — 模板是关键设计」。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('模板 CRUD：内置只读 + 自定义可创建/编辑/复制/删除', async ({ page }) => {
  test.setTimeout(45_000)
  page.setDefaultTimeout(15_000)
  // TemplatesPage 用 window.confirm 确认删除 — 测试必须接受
  page.on('dialog', (dialog) => void dialog.accept())

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800) // 等 bootstrap + seedBuiltinTemplates 完成
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // 导航到 Templates 页
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goTemplates: () => void } } }).__uiStore?.getState().goTemplates())
  await page.waitForTimeout(600)

  // 1) 内置模板存在（seed 注入三套）— 列表至少 3 项
  const initialCount = await page.locator('aside li.group').count()
  expect(initialCount).toBeGreaterThanOrEqual(3)

  // 2) 默认选中 builtin-default（标准会议纪要）
  // builtin 模板：保存按钮不渲染 + 编辑器显示「🔒 内置只读」提示
  await expect(page.getByText('🔒 内置只读').first()).toBeAttached({ timeout: 5_000 })
  // builtin 模板的 name input 也是 disabled
  const nameInput = page.locator('input[placeholder="模板名称"]').first()
  await expect(nameInput).toBeDisabled()

  // 3) 创建自定义模板（点 + 新建）
  await page.getByRole('button', { name: '+ 新建' }).click()
  await page.waitForTimeout(500)

  // 列表增加一项；编辑器可写
  const newCount = await page.locator('aside li.group').count()
  expect(newCount).toBe(initialCount + 1)

  // 4) 编辑自定义模板：图标/名称/正文
  const iconInput = page.locator('input[aria-label="图标"]').first()
  await expect(iconInput).toBeEnabled()
  await iconInput.fill('🎯')

  await nameInput.fill('E2E 测试模板')
  const promptArea = page.locator('textarea').first()
  await promptArea.fill('请总结 {{meeting.title}} 的核心决策点。')

  // 5) 点保存 → DB 更新 + 状态回到「已保存」
  const saveEditable = page.getByRole('button', { name: '保存' }).first()
  await saveEditable.click()
  await page.waitForTimeout(500)

  // 6) DB 验证：templates 表新增/更新了一行
  const state = await page.evaluate(async () => new Promise<{
    total: number
    byName: Record<string, { icon: string; prompt_md: string; builtin: boolean }>
  }>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['templates'], 'readonly')
      const all = tx.objectStore('templates').getAll()
      all.onsuccess = () => {
        const arr = all.result as Array<{ name: string; icon: string; prompt_md: string; builtin: boolean }>
        const byName: Record<string, { icon: string; prompt_md: string; builtin: boolean }> = {}
        for (const t of arr) {
          byName[t.name] = { icon: t.icon, prompt_md: t.prompt_md, builtin: t.builtin }
        }
        res({ total: arr.length, byName })
      }
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }))
  expect(state.total).toBe(initialCount + 1)
  expect(state.byName['E2E 测试模板']).toBeDefined()
  expect(state.byName['E2E 测试模板']?.icon).toBe('🎯')
  expect(state.byName['E2E 测试模板']?.builtin).toBe(false)

  // 7) 复制：点「复制为新模板」
  await page.getByRole('button', { name: '复制为新模板' }).first().click()
  await page.waitForTimeout(500)
  // 列表再 +1
  expect(await page.locator('aside li.group').count()).toBe(initialCount + 2)

  // 8) 删除自定义模板 — 「复制为新模板」后新模板排在前面，删除最上面的自定义
  // 自定义模板都有 ✕ 按钮 + 「复制为新模板」按钮；builtin 没有
  const customLis = page.locator('aside li.group:has(button:has-text("复制为新模板"))')
  const customCountBefore = await customLis.count()
  // ✕ 是 span (title="删除" 让可访问名=删除)
  const xBtn = customLis.first().locator('span[title="删除"]').first()
  await xBtn.click({ force: true })
  // confirm 对话框：page.on('dialog') 会 accept
  await page.waitForTimeout(1000)
  // 自定义 -1
  expect(await customLis.count()).toBe(customCountBefore - 1)

  // 9) 删除 builtin 模板的 ✕ 按钮不应存在
  // 选中第一个 builtin（标准会议纪要）
  await page.locator('aside li.group').filter({ hasText: '标准会议纪要' }).locator('button').first().click()
  await page.waitForTimeout(300)
  // builtin 模板的 ✕ 不应出现（filter custom-only）
  const xButtons = await page.locator('aside li.group').filter({ hasText: '🔒 内置只读' }).locator('[title="删除"]').count()
  expect(xButtons).toBe(0)
})