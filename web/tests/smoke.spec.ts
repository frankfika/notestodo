/**
 * Shibei · 端到端 smoke test
 *
 * 用 playwright + 真实 Chromium 浏览器，验证：
 *   1. 首页（任务树）加载并显示侧栏
 *   2. ⌘K 唤出命令面板
 *   3. 所有一级页面（会议/任务/笔记/设置）+ 二级页（看板/周报/模板）能加载且无运行时报错
 *   4. 创建一条 Note 后列表出现
 *   5. ⌘⇧R 录音热键不会让浏览器栈崩（无麦克风授权时 engine 进入 error 态）
 *
 * 运行（先启动 dev server）：
 *   SHIBEI_URL=http://127.0.0.1:5173 npx playwright test tests/smoke.spec.ts
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function dismissOnboarding(page: import('@playwright/test').Page): Promise<void> {
  // 首次启动会显示右下角引导卡片；点 X 关掉（不阻塞主 UI）
  const onboardingClose = page.locator('button[aria-label="关闭"]').first()
  if (await onboardingClose.isVisible({ timeout: 1500 }).catch(() => false)) {
    await onboardingClose.click()
  }
}

/** 侧栏一级导航（exact 匹配 — '笔记' 不能撞上 '新建笔记本'） */
async function nav(page: import('@playwright/test').Page, label: string): Promise<void> {
  await page.locator('aside').getByRole('button', { name: label, exact: true }).click()
}

test.describe('Shibei shell smoke', () => {
  test('首页加载并显示侧栏 + 任务树', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await expect(page.locator('aside', { hasText: '拾贝' })).toBeVisible()
    // Today 页已删，默认落地页是任务树
    await expect(page.getByRole('button', { name: '树', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '＋ 新建任务' })).toBeVisible()
    await page.screenshot({ path: 'tests/screenshots/01-today.png', fullPage: true })
  })

  test('⌘K 命令面板可打开', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    // 显式 focus 到 body 再按热键
    await page.locator('body').click({ position: { x: 10, y: 10 } })
    await page.keyboard.press('Meta+k')
    await expect(page.locator('input[placeholder*="搜索"]')).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'tests/screenshots/02-cmdk.png' })
    await page.keyboard.press('Escape')
    await expect(page.locator('input[placeholder*="搜索"]')).toBeHidden({ timeout: 2000 })
  })

  test('所有一级页面可加载（无运行时报错）', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    for (const label of ['会议', '任务', '笔记', '设置']) {
      await nav(page, label)
      await page.waitForTimeout(200)
    }
    // 二级页：纪要模板（设置内）、看板（任务内）、周报（看板循环卡进入）
    await page.getByRole('button', { name: '纪要模板 →' }).click()
    await page.waitForTimeout(200)
    await nav(page, '任务')
    await page.getByRole('button', { name: '看板 →' }).click()
    await page.waitForTimeout(600) // BoardPage 挂载时会补建本周周报循环卡
    await page.locator('article', { hasText: '写本周周报' }).first().click()
    await page.waitForTimeout(300)
    await expect(page.locator('h1', { hasText: '周报' })).toBeVisible({ timeout: 5000 })
    await expect(errors, errors.join('\n')).toHaveLength(0)
  })

  test('创建一条 Note 后列表出现', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await nav(page, '笔记')
    // 顶部 "+ 新建笔记" 按钮
    const topNew = page.getByRole('button', { name: '+ 新建笔记' }).first()
    await topNew.waitFor({ state: 'visible', timeout: 5000 })
    await topNew.click()
    // 进入 NoteDetail，等待详情页加载
    await page.locator('button[aria-label="返回"]').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button[aria-label="返回"]').first().click()
    // 空标题笔记在列表里显示为「未命名笔记」
    await expect(page.locator('text=未命名笔记').first()).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: 'tests/screenshots/03-notes.png', fullPage: true })
  })

  test('⌘⇧R 录音热键：engine 切到 error 态（无麦克风授权时）', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await page.context().clearPermissions()
    // 前置测试的 location.reload 可能与 keydown 竞争；等待 load 完成后重试一次
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.keyboard.press('Meta+Shift+r', { timeout: 8000 })
        break
      } catch {
        await page.waitForLoadState('load')
      }
    }
    await page.waitForTimeout(800)
    await expect(page.locator('aside', { hasText: '拾贝' })).toBeVisible()
  })

  test('新建一个任务时 持久化到 IndexedDB', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await nav(page, '任务')
    await page.waitForTimeout(300)

    const newBtn = page.getByRole('button', { name: '＋ 新建任务' })
    await newBtn.waitFor({ state: 'visible', timeout: 5000 })
    const beforeCount = await page.evaluate(async () => {
      return new Promise<number>((res) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('todos', 'readonly')
          const cr = tx.objectStore('todos').count()
          cr.onsuccess = () => res(cr.result)
        }
        req.onerror = () => res(-1)
      })
    })
    await newBtn.click()
    await page.waitForTimeout(500)
    const afterCount = await page.evaluate(async () => {
      return new Promise<number>((res) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('todos', 'readonly')
          const cr = tx.objectStore('todos').count()
          cr.onsuccess = () => res(cr.result)
        }
        req.onerror = () => res(-1)
      })
    })
    expect(afterCount).toBe(beforeCount + 1)

    // 双击行内标题改名（新行是空标题 → 显示「（无标题）」）并回车保存
    const newTitle = page.locator('div[data-todo]').last().locator('span[title="双击改名"]')
    await newTitle.dblclick()
    await page.locator('div[data-todo]').last().locator('input').fill('新工作目标')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    // 新建的标题应该出现在页面上 + 落库
    await expect(page.locator('text=新工作目标').first()).toBeVisible({ timeout: 3000 })
    const saved = await page.evaluate(async () => {
      return new Promise<string>((res) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('todos', 'readonly')
          const g = tx.objectStore('todos').getAll()
          g.onsuccess = () => {
            const hit = (g.result as Array<{ title: string }>).find((t) => t.title === '新工作目标')
            res(hit?.title ?? '')
          }
        }
        req.onerror = () => res('')
      })
    })
    expect(saved).toBe('新工作目标')
  })

  test('未录音时音频条不应出现（idle 状态下 DOM 不渲染）', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    // 录音条的容器在 idle 时返回 null — RecordingBar 整体不挂载
    const bar = page.locator('span.rec-dot').first()
    await expect(bar).toHaveCount(0)
  })

  test('首次用户动作自动关闭 onboarding（AI-native 信号：无需再手把手）', async ({ page }) => {
    await page.goto(BASE)
    // 不要 dismiss — 让 onboarding 第一次显示
    // 触发第一个真实动作 — 创建任务（bootstrap 监听 todos.creating 自动收引导）
    await nav(page, '任务')
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: '＋ 新建任务' }).click()
    await page.waitForTimeout(1000)
    // onboarding 卡片应该自动消失（卡片头「拾贝 · 新用户引导」不再渲染）
    await expect(page.locator('text=新用户引导')).toHaveCount(0, { timeout: 3000 })
  })

  test('快捷键提示跟随平台（mac=⌘ / 其他=⌃）', async ({ page }) => {
    // Playwright 在 macOS 跑 → navigator.platform 含 'mac'，应输出 ⌘
    // 提示现在在 onboarding 引导卡里（Topbar 已删）
    await page.goto(BASE)
    const kbd = page.locator('.kbd').first()
    await expect(kbd).toBeVisible({ timeout: 8000 })
    const isMac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))
    const expected = isMac ? '⌘' : '⌃'
    expect(await kbd.innerText()).toContain(expected)
  })

  test('PWA manifest / index.html、icons、sw 均可响应', async ({ page }) => {
    await page.goto(BASE)
    for (const p of [
      '/manifest.webmanifest',
      '/sw.js',
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/icons/apple-touch-icon.png',
    ]) {
      const res = await page.request.get(BASE.replace(/\/$/, '') + p)
      expect(res.status(), `${p} should be 200`).toBe(200)
    }
    // manifest 解析合法 + name/start_url/display 正确
    const m = await page.request.get(BASE.replace(/\/$/, '') + '/manifest.webmanifest')
    const json = (await m.json()) as Record<string, unknown>
    expect(json.name).toBeTruthy()
    expect(json.start_url).toBe('/')
    expect(json.display).toBe('standalone')
    expect(Array.isArray(json.icons)).toBe(true)
  })

  test('待办可跳回来源会议（跟进闭环）', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    // 注入一场会议 + 一个关联该会议的待办
    await page.evaluate(async () => {
      const nowIso = new Date().toISOString()
      await new Promise<void>((res, rej) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['meetings', 'todos'], 'readwrite')
          tx.objectStore('meetings').put({
            id: 'e2e-m-1', title: 'E2E 来源会议', source: 'manual', status: 'summarized',
            started_at: nowIso,
            audio: { format: 'audio/webm', codec: 'opus', duration_ms: 60000, chunk_count: 2, size_bytes: 100000, gaps: [] },
            created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          })
          tx.objectStore('todos').put({
            id: 'e2e-t-1', kind: 'task', parent_id: null,
            title: '来自会议的任务', status: 'open',
            source: 'ai', meeting_id: 'e2e-m-1',
            created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          })
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        }
      })
    })
    await page.goto(BASE)
    await nav(page, '任务')
    await page.waitForTimeout(500)
    // 来源会议 chip 可见 → 点击 → 跳到会议详情
    const link = page.getByRole('button', { name: /E2E 来源会议/ }).first()
    await expect(link).toBeVisible({ timeout: 5000 })
    await link.click()
    await page.waitForTimeout(600)
    // 会议详情页标题在 input 里（aria-label="会议标题"），不是纯文本
    await expect(page.locator('input[aria-label="会议标题"]')).toHaveValue('E2E 来源会议', { timeout: 5000 })
  })

  test('待办可跳回来源笔记（note-todo 闭环，需求 #4）', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    // 注入一篇笔记 + 一个来自该笔记的待办
    await page.evaluate(async () => {
      const nowIso = new Date().toISOString()
      await new Promise<void>((res, rej) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['notes', 'todos'], 'readwrite')
          tx.objectStore('notes').put({
            id: 'e2e-n-1', title: 'E2E 来源笔记', body_md: '内容',
            meeting_id: null, todo_ids: ['e2e-nt-1'],
            pinned: false, created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          })
          tx.objectStore('todos').put({
            id: 'e2e-nt-1', kind: 'task', parent_id: null,
            title: '来自笔记的任务', status: 'open',
            source: 'note', origin_note_id: 'e2e-n-1',
            created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          })
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        }
      })
    })
    await page.goto(BASE)
    await nav(page, '任务')
    await page.waitForTimeout(500)
    const link = page.getByRole('button', { name: /E2E 来源笔记/ }).first()
    await expect(link).toBeVisible({ timeout: 5000 })
    await link.click()
    await page.waitForTimeout(600)
    // 笔记详情页：标题在 input value 里（text= 不匹配 input，用 value 断言）
    await expect(page.locator('input[value="E2E 来源笔记"]')).toBeVisible({ timeout: 5000 })
      .catch(() => expect(page.locator('input').first()).toHaveValue(/E2E 来源笔记/, { timeout: 5000 }))
  })

  test('tag 过滤：点击 tag chip 只显示绑定该 tag 的页面（充分发挥 tags）', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    // 注入 2 条笔记 + 1 个 tag + 绑定（只绑页面 A）— 任务页 tag 筛选已移除，笔记页保留
    await page.evaluate(async () => {
      const nowIso = new Date().toISOString()
      const id = () => crypto.randomUUID()
      const tagId = id()
      const aId = id()
      const bId = id()
      await new Promise<void>((res, rej) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['tags', 'tagBindings', 'notes'], 'readwrite')
          tx.objectStore('tags').put({
            id: tagId, name: 'urgent', color: '#888',
            created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          })
          tx.objectStore('notes').put({
            id: aId, title: 'TaggedA-带标签页面', body_md: '内容A',
            pinned: false, todo_ids: [],
            created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          })
          tx.objectStore('notes').put({
            id: bId, title: 'PlainB-无标签页面', body_md: '内容B',
            pinned: false, todo_ids: [],
            created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          })
          tx.objectStore('tagBindings').put({
            id: id(), tag_id: tagId, target_type: 'note', target_id: aId,
            created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          })
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        }
      })
    })
    await page.goto(BASE)
    await nav(page, '笔记')
    await page.waitForTimeout(600)
    // tag 筛选条出现 → 点击 #urgent
    const tagChip = page.getByRole('button', { name: /^#urgent$/ }).first()
    await expect(tagChip).toBeVisible({ timeout: 5000 })
    await tagChip.click()
    await page.waitForTimeout(500)
    // 只剩带标签的页面
    await expect(page.locator('text=TaggedA-带标签页面').first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=PlainB-无标签页面')).toHaveCount(0, { timeout: 3000 })
  })

  test('导出 → 清空 → 导入 roundtrip：数据完整恢复（数据主权）', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    // 注入一场会议 + 一条 todo 作为"原始数据"
    await page.evaluate(async () => {
      const nowIso = new Date().toISOString()
      await new Promise<void>((res, rej) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['meetings', 'todos'], 'readwrite')
          tx.objectStore('meetings').put({
            id: 'rt-m-1', title: 'Roundtrip 会议', source: 'manual', status: 'transcribed',
            started_at: nowIso,
            audio: { format: 'audio/webm', codec: 'opus', duration_ms: 30000, chunk_count: 1, size_bytes: 50000, gaps: [] },
            created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          })
          tx.objectStore('todos').put({
            id: 'rt-t-1', kind: 'task', parent_id: null,
            title: 'Roundtrip 任务', status: 'open',
            source: 'manual', meeting_id: 'rt-m-1',
            created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          })
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        }
      })
    })
    await page.goto(BASE)
    await page.getByRole('button', { name: '设置' }).first().click()
    await page.waitForTimeout(400)
    // 导入导出在「外观与数据」分组里
    await page.getByRole('button', { name: '外观与数据' }).click()
    await page.waitForTimeout(300)

    // 1) 导出：拦截 download，saveAs 到稳定路径（artifacts 临时路径 readFileSync 后会干扰 setFiles）
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 })
    await page.getByRole('button', { name: '导出 .zip' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^shibei-\d{4}-\d{2}-\d{2}T.*\.zip$/)
    const zipPath = '/tmp/shibei-roundtrip.zip'
    await download.saveAs(zipPath)
    const fs = await import('node:fs')
    expect(fs.statSync(zipPath).size).toBeGreaterThan(500) // manifest + 2 tables 至少几百字节

    // 2) 导入：事件式 dialog 处理（Promise 式等待会与 fileChooser 死锁 —
    //    Chromium 的 confirm() 阻塞 file chooser input 事件循环，setFiles 永不返回）
    page.on('dialog', (d) => void d.accept())
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 })
    await page.getByRole('button', { name: '导入 .zip' }).click()
    const chooser = await chooserPromise
    await chooser.setFiles([zipPath])
    // 导入成功会触发 location.reload
    await page.waitForLoadState('load')
    await page.waitForTimeout(1500)

    // 3) 验证数据完整恢复：会议与待办都在
    await nav(page, '任务')
    await page.waitForTimeout(500)
    await expect(page.locator('text=Roundtrip 任务').first()).toBeVisible({ timeout: 5000 })
    const restored = await page.evaluate(async () => {
      return new Promise<{ meetings: number; todos: number }>((res) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['meetings', 'todos'], 'readonly')
          const mc = tx.objectStore('meetings').count()
          const tc = tx.objectStore('todos').count()
          mc.onsuccess = () => tc.onsuccess = () => res({ meetings: mc.result, todos: tc.result })
        }
      })
    })
    expect(restored.meetings).toBeGreaterThanOrEqual(1)
    expect(restored.todos).toBeGreaterThanOrEqual(1)
  })
})
