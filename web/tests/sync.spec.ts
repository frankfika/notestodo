/**
 * 多端同步 e2e —— 用本地内存版 relay（与 Cloudflare Worker 共用 relay/core.mjs）。
 *
 * 覆盖三件事：
 * 1. 本机新建任务 → 推送进 relay；
 * 2. 另一台设备的新任务 → 拉回本机并出现在 UI；
 * 3. 两台设备改同一条 → 本地保留 + 生成「（冲突副本）」，不丢数据。
 */
import { test, expect } from '@playwright/test'
import { useClassicTasks } from './classic'
// @ts-expect-error 纯 JS 共享核心，无类型声明
import { startFakeRelay } from './fake-relay.mjs'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'
const TOKEN = 'e2e-sync-token'

type TodoRow = { id: string; title: string; updated_at: string }

async function readTodo(page: import('@playwright/test').Page, title: string): Promise<TodoRow | null> {
  return page.evaluate(
    (t) =>
      new Promise<TodoRow | null>((resolve, reject) => {
        const req = indexedDB.open('shibei')
        req.onsuccess = () => {
          const idb = req.result
          const tx = idb.transaction(['todos'], 'readonly')
          const all = tx.objectStore('todos').getAll()
          all.onsuccess = () => resolve((all.result as TodoRow[]).find((r) => r.title === t) ?? null)
          all.onerror = () => reject(all.error)
        }
      }),
    title,
  )
}

async function devicePush(
  url: string,
  deviceId: string,
  change: { id: string; title: string; updated_at: string },
): Promise<void> {
  const res = await fetch(`${url}/v1/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      device_id: deviceId,
      cursor: 0,
      changes: [
        {
          entity: 'todos',
          id: change.id,
          op: 'upsert',
          data: { id: change.id, kind: 'task', parent_id: null, scope: null, status: 'open', title: change.title, source: 'manual', sort_order: 0, created_at: change.updated_at, updated_at: change.updated_at, deleted_at: null, sync_version: 0 },
          updated_at: change.updated_at,
          sync_version: 0,
          deleted_at: null,
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`device push failed: ${res.status}`)
}

test('同步：推送 / 拉取 / 冲突副本', async ({ page }) => {
  test.setTimeout(60_000)
  const relay = await startFakeRelay()

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await useClassicTasks(page)
    await page.waitForTimeout(400)
    const close = page.locator('button[aria-label="关闭"]').first()
    if (await close.isVisible({ timeout: 1500 }).catch(() => false)) await close.click()

    // 配置指向本地 relay（raw kv 写入后 reload 让 App 读到）
    await page.evaluate(
      ({ url }) =>
        new Promise<void>((resolve, reject) => {
          const req = indexedDB.open('shibei')
          req.onsuccess = () => {
            const idb = req.result
            const tx = idb.transaction(['kv'], 'readwrite')
            tx.objectStore('kv').put({
              key: 'settings',
              value: { sync_server_url: url, sync_token: 'e2e-sync-token', sync_enabled: true, sync_interval_min: 5, sync_device_name: '设备A' },
            })
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
          }
        }),
      { url: relay.url },
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(600)

    // ── 1. 本机建任务 → 同步 → relay 收到 ─────────────────────────
    await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goTodos: () => void } } }).__uiStore?.getState().goTodos())
    const quickAdd = page.getByPlaceholder(/添加任务/)
    await quickAdd.fill('同步测试任务')
    await quickAdd.press('Enter')
    await expect(page.getByText('同步测试任务')).toBeVisible()
    await page.waitForTimeout(500) // 等 hook 写入发件箱

    await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goSettings: () => void } } }).__uiStore?.getState().goSettings())
    await page.getByRole('button', { name: '多端同步', exact: true }).click()
    await page.getByRole('button', { name: '立即同步' }).click()
    await expect(page.getByText(/同步完成/)).toBeVisible()

    const relayState = relay.state.get(TOKEN)
    const pushed = relayState ? Object.values(relayState.latest ?? {}) : []
    expect(pushed.some((e: { entity: string; data?: { title?: string } }) => e.entity === 'todos' && e.data?.title === '同步测试任务')).toBe(true)

    // ── 2. 另一台设备建任务 → 本机同步后拉回来 ─────────────────────
    await devicePush(relay.url, 'device-B', { id: 'todo-from-b', title: 'B 设备的任务', updated_at: new Date().toISOString() })
    await page.getByRole('button', { name: '立即同步' }).click()
    await expect(page.getByText(/同步完成/)).toBeVisible()
    await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goTodos: () => void } } }).__uiStore?.getState().goTodos())
    await expect(page.getByText('B 设备的任务')).toBeVisible()

    // ── 3. 两台设备改同一条：B 推来更新的版本 → 本机落败，本地版进「冲突副本」 ──
    // 先在本机改名（本地版），随后 B 推一个更新的版本 —— 同步时本机推送落败 + 拉取被覆盖，
    // 两条路径都命中也只留一份副本；赢家（B 的版本）不再像旧实现那样在推送侧生成重复副本。
    await page.getByText('B 设备的任务').dblclick()
    const renameInput = page.locator('input:focus')
    await renameInput.fill('本机改的名字')
    await renameInput.press('Enter')
    await expect(page.getByText('本机改的名字')).toBeVisible()
    await page.waitForTimeout(500)
    // B 推更新的版本（比本机改名晚 5s）→ relay 上 B 赢
    await devicePush(relay.url, 'device-B', { id: 'todo-from-b', title: 'B 改的名字', updated_at: new Date(Date.now() + 5000).toISOString() })

    await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goSettings: () => void } } }).__uiStore?.getState().goSettings())
    await page.getByRole('button', { name: '多端同步', exact: true }).click()
    await page.getByRole('button', { name: '立即同步' }).click()
    await expect(page.getByText(/冲突 1/)).toBeVisible()
    await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goTodos: () => void } } }).__uiStore?.getState().goTodos())
    // 拉回来的赢家版本可见；本机落败的版本以副本形式保留 —— 不丢数据
    await expect(page.getByText('B 改的名字', { exact: true })).toBeVisible()
    await expect(page.getByText(/（冲突副本）/).first()).toBeVisible()

    // 本地库里：赢家版本在、落败版本只剩副本、且没有赢家副本（旧 bug 是推送侧也存一份）
    expect(await readTodo(page, 'B 改的名字')).not.toBeNull()
    expect(await readTodo(page, '本机改的名字')).toBeNull()
    expect(await readTodo(page, '本机改的名字（冲突副本）')).not.toBeNull()
    expect(await readTodo(page, 'B 改的名字（冲突副本）')).toBeNull()
  } finally {
    await relay.close()
  }
})
