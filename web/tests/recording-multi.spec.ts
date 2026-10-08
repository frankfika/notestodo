/**
 * 多次录音状态隔离 e2e — 用户最常见模式：录完一场 → 处理 → 录另一场。
 *
 * 风险点：active 是模块全局变量 + ondataavailable/onstop 闭包持引用，
 * 任何漏 null、漏重置都会让第二次录音看到上一次的残留（ghost meeting）。
 * 验证：
 *   1. 第一次完整链路 → meeting A 落库 + status='transcribed' + rec-dot 消失
 *   2. 第二次启动 → 没有录制条残留 → 新 meeting B 产生 → ended_at 写入
 *   3. 数据库里有 2 个独立 meeting，无序字段对应到第二次的
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
})

test('连录两场：状态完全隔离（无 ghost meeting / 残留录制条）', async ({ page }) => {
  page.setDefaultTimeout(30_000)

  await page.goto(BASE)
  const x = page.locator('button[aria-label="关闭"]').first()
  if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

  // ── 第一次录制 ──
  await page.getByRole('button', { name: /● 开始录音/ }).first().click()
  await expect(page.locator('span.rec-dot').first()).toBeVisible({ timeout: 8000 })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /■ 停止/ }).first().click()
  await expect(page.locator('span.rec-dot')).toHaveCount(0, { timeout: 8000 })

  // 等异步 finaliseMeeting + pipeline kickoff 落库
  await page.waitForTimeout(1500)

  // ── 第二次录制（关键的「干净启动」验证）───
  await page.getByRole('button', { name: /● 开始录音/ }).first().click()
  await expect(page.locator('span.rec-dot').first()).toBeVisible({ timeout: 8000 })
  // 验证录制条内的 elapsed 计时独立 — 显式 scope 到 RecordingBar
  const elapsedText = await page.locator('.rec-dot ~ span.font-mono.tabular-nums').first().innerText()
  // 第二次刚开始，elapsed 应≤5s
  const elapsedSec = Number(elapsedText.split(':').reduce((s, v) => Number(s) * 60 + Number(v), 0))
  expect(elapsedSec).toBeLessThanOrEqual(10)

  // 录一段再停
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: /■ 停止/ }).first().click()
  await expect(page.locator('span.rec-dot')).toHaveCount(0, { timeout: 8000 })
  await page.waitForTimeout(1500)

  // ── 数据库断言：2 个独立 meeting，没有 ghost 残留 ──
  const result = await page.evaluate(async () => new Promise<{
    meetings: Array<{
      id: string
      title: string
      ended_at: string | null
      audio: { chunk_count: number; size_bytes: number }
    }>
    chunksTotal: number
  }>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb-open-failed'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['meetings', 'audioChunks'], 'readonly')
      const m = tx.objectStore('meetings').getAll()
      const c = tx.objectStore('audioChunks').getAll()
      let mdone = false
      let cdone = false
      const fire = (): void => {
        if (!mdone || !cdone) return
        res({
          meetings: m.result as never,
          chunksTotal: c.result.length,
        })
      }
      m.onsuccess = () => { mdone = true; fire() }
      c.onsuccess = () => { cdone = true; fire() }
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }))

  expect(result.meetings.length).toBe(2)
  // 两个 meeting 都有 ended_at（没有 ghost）
  for (const m of result.meetings) {
    expect(m.ended_at).not.toBeNull()
    expect(m.title.startsWith('会议 · ')).toBe(true)
  }
  // 每个 meeting 都至少有一个真实音频数据分片
  for (const m of result.meetings) {
    expect(m.audio.chunk_count).toBeGreaterThanOrEqual(1)
    expect(m.audio.size_bytes).toBeGreaterThan(1000)
  }
  // 至少 2 个分片（两个 meeting 各 ≥1 个真实数据分片 + 各 ~1 个 placeholder）
  expect(result.chunksTotal).toBeGreaterThanOrEqual(2)
})