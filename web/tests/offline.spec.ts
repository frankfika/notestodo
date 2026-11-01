/**
 * 断网可用性 e2e —— openNotion 是本地优先产品：断网后必须还能打开、还能读写本机数据。
 *
 * 验证：
 *   1. 首访装上 service worker 且壳已缓存
 *   2. setOffline(true) 后重载：页面照常渲染（SW 离线回退生效）
 *   3. IndexedDB 里的数据在断网状态下仍可读
 *   4. 断网期间没有未捕获的运行时错误
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('断网后应用仍可用（SW 离线壳 + 本地数据）', async ({ page, context }) => {
  test.setTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // 1) 首访：装 SW 并缓存壳
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // SW 只在生产构建注册（dev 下不注册，避免 HMR 吃到旧缓存）。
  // 这条用例因此只对生产构建生效：pnpm build && pnpm preview --port 4173
  const isProdBuild = await page.evaluate(() => !!document.querySelector('script[src^="/assets/"]'))
  test.skip(!isProdBuild, '需要生产构建（pnpm build && pnpm preview）才能验证 service worker')

  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported'
    const reg = await navigator.serviceWorker.ready
    return reg.active ? 'active' : 'none'
  })
  expect(swState).toBe('active')

  const cachedShell = await page.evaluate(async () => {
    for (const k of await caches.keys()) {
      const c = await caches.open(k)
      if (await c.match('/')) return k
    }
    return null
  })
  expect(cachedShell).toBeTruthy()

  // 2) 写一条本地数据（原生 IndexedDB：生产构建里没有 /src 源码可 import）
  const noteId = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const ts = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onerror = () => rej(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['notes'], 'readwrite')
        tx.objectStore('notes').put({
          id, title: '离线笔记', body_md: '断网也要能读', meeting_id: undefined, todo_ids: [],
          pinned: false, parent_id: null, notebook_id: null, sort_order: Date.now(),
          created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })

  // 3) 断网 → 重载
  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  expect(await page.evaluate(() => navigator.onLine)).toBe(false)

  // 应用渲染了（默认落地页是 AI 工作台）
  await expect(page.getByText('AI 工作台').first()).toBeVisible({ timeout: 10_000 })

  // 本地数据在断网状态下仍可读
  const title = await page.evaluate(async (id) => {
    return new Promise<string | null>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onerror = () => rej(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['notes'], 'readonly')
        const get = tx.objectStore('notes').get(id)
        get.onsuccess = () => res((get.result as { title?: string } | undefined)?.title ?? null)
        get.onerror = () => rej(get.error)
      }
    })
  }, noteId)
  expect(title).toBe('离线笔记')

  expect(errors).toEqual([])

  await context.setOffline(false)
})
