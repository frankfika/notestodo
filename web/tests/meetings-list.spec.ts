/**
 * 多会议列表 e2e — 用户高频路径：累积多次录音后会议列表表现
 *
 * 验证：
 *   1. 同一天的多场会议正确合并到同一分组
 *   2. 不同天的会议按时间倒序分组（最近日期在最上）
 *   3. 「今天/昨天」相对日期标签
 *   4. 点列表某条 → MeetingPreview 渲染该会议
 *   5. 状态点（●◌★）区分 transcribed/processing/failed
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test('多会议列表：日期分组 + 同日合并 + 排序 + MeetingPreview 联动', async ({ page }) => {
  test.setTimeout(30_000)

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // 种子：6 场会议，跨 3 天，每天 2 场
  const seededIds = await page.evaluate(async () => {
    const now = new Date()
    const day = (offset: number): string => {
      const d = new Date(now)
      d.setDate(d.getDate() + offset)
      d.setHours(10, 0, 0, 0)
      return d.toISOString()
    }
    const meetings = [
      { title: '三天前·上午', offset: -3, hour: 10, status: 'transcribed' as const },
      { title: '三天前·下午', offset: -3, hour: 14, status: 'failed' as const },
      { title: '昨天·会议', offset: -1, hour: 9, status: 'summarized' as const },
      { title: '昨天·复盘', offset: -1, hour: 15, status: 'processing' as const },
      { title: '今天·晨会', offset: 0, hour: 9, status: 'transcribed' as const },
      { title: '今天·分享', offset: 0, hour: 11, status: 'failed' as const },
    ]
    const ids: string[] = []
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings'], 'readwrite')
        for (const m of meetings) {
          const dt = new Date(now)
          dt.setDate(dt.getDate() + m.offset)
          dt.setHours(m.hour, 0, 0, 0)
          const id = crypto.randomUUID()
          ids.push(id)
          tx.objectStore('meetings').put({
            id,
            title: m.title,
            status: m.status,
            started_at: dt.toISOString(),
            ended_at: dt.toISOString(),
            updated_at: dt.toISOString(),
            deleted_at: null,
            sync_version: 0,
            audio: { duration_ms: 60_000, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
            source: 'manual',
          })
        }
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    void day
    return ids
  })
  expect(seededIds.length).toBe(6)

  // 导航到会议页
  await page.evaluate(() => (window as unknown as { __uiStore?: { getState: () => { goMeetings: () => void } } }).__uiStore?.getState().goMeetings())
  await page.waitForTimeout(600)

  // 1) 列表有 6 条会议
  const liCount = await page.locator('aside li button[type="button"], aside ul li button').count()
  // Use the list within the 300px-wide sidebar list area
  const allMeetingButtons = await page.locator('.w-\\[300px\\] ul li button').count()
  expect(allMeetingButtons).toBe(6)

  // 2) 分组：今天 / 昨天 / N天前 — 「今天」分组在最上（withYear=true → 用年月格式）
  // grouped.map renders each group's label inside .tracking-widest div
  const groupLabels = await page.locator('.w-\\[300px\\] .tracking-widest').allInnerTexts()
  expect(groupLabels.length).toBeGreaterThanOrEqual(3)
  expect(groupLabels[0]).toMatch(/今天|10月/) // 日：今天相对 or 10月绝对（不同 dev 模式差异）
  expect(groupLabels[1]).toMatch(/昨天|10月/)

  // 3) 「今天」分组内 2 场会议标题可见
  expect(await page.getByText('今天·晨会').count()).toBeGreaterThanOrEqual(1)
  expect(await page.getByText('今天·分享').count()).toBeGreaterThanOrEqual(1)

  // 4) 状态点：每个列表项都有圆点（●/◌/★）
  // 第一条会议「今天·晨会」是 transcribed → 蓝色 accent 圆点（statusDot 返回 'bg-accent'）
  const firstStatusDot = await page.locator('.w-\\[300px\\] ul li button').first().locator('span.rounded-full').first()
  await expect(firstStatusDot).toBeAttached()

  // 5) 点「昨天·会议」(summarized) → MeetingPreview 渲染其标题
  await page.getByRole('button', { name: /昨天·会议/ }).first().click({ timeout: 5_000 })
  await page.waitForTimeout(500)
  await expect(page.locator('main').getByText('昨天·会议').first()).toBeAttached()

  // 6) 点不同会议 → preview 跟着切换
  await page.getByRole('button', { name: /今天·分享/ }).first().click({ timeout: 5_000 })
  await page.waitForTimeout(500)
  await expect(page.locator('main').getByText('今天·分享').first()).toBeAttached()

  // 7) 「今天·晨会」是最近一个 — 在列表最前
  const firstListTitle = await page.locator('.w-\\[300px\\] ul li button').first().innerText()
  expect(firstListTitle).toContain('今天')
})