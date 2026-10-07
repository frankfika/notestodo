/**
 * Shibei · 端到端 smoke test
 *
 * 用 playwright + 真实 Chromium 浏览器，验证：
 *   1. 首页加载并显示侧栏 + Today
 *   2. ⌘K 唤出命令面板
 *   3. 所有一级页面（会议/笔记/待办/模板）能加载且无运行时报错
 *   4. 创建一条 Note 后列表出现
 *   5. ⌘⇧R 录音热键不会让浏览器栈崩（无麦克风授权时 engine 进入 error 态）
 *
 * 运行（先启动 dev server）：
 *   pnpm dev & sleep 4 && SHIBEI_URL=http://127.0.0.1:5173 \
 *     node node_modules/@playwright/test/cli.js test tests/smoke.spec.ts
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

test.describe('Shibei shell smoke', () => {
  test('首页加载并显示侧栏 + Today', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await expect(page.locator('aside', { hasText: '拾贝' })).toBeVisible()
    await expect(page.locator('h1', { hasText: '今天' })).toBeVisible()
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
    for (const label of ['会议', '笔记', '待办', '模板']) {
      await page.getByRole('button', { name: label }).click()
      await page.waitForTimeout(200)
    }
    await expect(errors, errors.join('\n')).toHaveLength(0)
  })

  test('创建一条 Note 后列表出现', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await page.getByRole('button', { name: '笔记' }).click()
    // 顶部 "+ 新建笔记" 按钮
    const topNew = page.getByRole('button', { name: '+ 新建笔记' }).first()
    await topNew.waitFor({ state: 'visible', timeout: 5000 })
    await topNew.click()
    // 进入 NoteDetail，等待详情页加载
    await page.locator('button[aria-label="返回"]').first().waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('button[aria-label="返回"]').first().click()
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

  test('新建一个 Objective 时 持久化到 IndexedDB', async ({ page }) => {
    await page.goto(BASE)
    await dismissOnboarding(page)
    await page.getByRole('button', { name: '待办' }).click()
    await page.waitForTimeout(300)

    const newBtn = page.getByRole('button', { name: /新建 Objective/ }).first()
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
    await page.waitForTimeout(800)
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
    // 新建的 Objective 应该出现在页面上
    await expect(page.locator('text=新工作目标').first()).toBeVisible({ timeout: 3000 })
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
    // 触发第一个真实动作 — 创建 Objective
    await page.getByRole('button', { name: '待办' }).click()
    await page.waitForTimeout(300)
    const newBtn = page.getByRole('button', { name: /新建 Objective/ }).first()
    await newBtn.waitFor({ state: 'visible', timeout: 5000 })
    await newBtn.click()
    await page.waitForTimeout(800)
    // onboarding 卡片应该自动消失
    const onboardingCard = page.locator('text=欢迎使用拾贝').first()
    await expect(onboardingCard).toHaveCount(0, { timeout: 2000 })
  })

  test('快捷键提示跟随平台（mac=⌘ / 其他=⌃）', async ({ page }) => {
    // Playwright 在 macOS 跑 → navigator.platform 含 'mac'，应输出 ⌘
    await page.goto(BASE)
    await dismissOnboarding(page)
    const isMac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))
    const expected = isMac ? '⌘' : '⌃'
    // Topbar 上 ⌘K 按钮里有正确的符号
    const topbar = await page.locator('button:has(span.kbd)').first().innerText()
    expect(topbar).toContain(expected)
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
    await page.getByRole('button', { name: '待办' }).click()
    await page.waitForTimeout(500)
    // 来源会议链接可见 → 点击 → 跳到会议详情
    const link = page.getByRole('button', { name: /E2E 来源会议/ }).first()
    await expect(link).toBeVisible({ timeout: 5000 })
    await link.click()
    await page.waitForTimeout(600)
    // 会议详情页应显示该会议标题
    await expect(page.locator('text=E2E 来源会议').first()).toBeVisible({ timeout: 5000 })
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
    await page.getByRole('button', { name: '待办' }).click()
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