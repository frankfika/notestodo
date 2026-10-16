/**
 * 应用内置本地模型 UX（DEV 模拟后端：localStorage.builtin_mock=1）：
 *   选「本机内置」立即生效 → 数据去向全本机 → 录完再下模型：会议「等待模型」→ 一键下载 → 自动续跑出笔记 + 待办。
 * 浏览器版（不开模拟）：「本机内置」禁用并说明需要桌面版。
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __uiStore: { getState: () => { goSettings: () => void } } }).__uiStore.getState().goSettings())
  await expect(page.getByRole('radiogroup', { name: 'AI 运行在哪里' })).toBeVisible()
}

test('浏览器版：本机内置不可选，并说明需要桌面版', async ({ page }) => {
  await page.goto(BASE)
  await openSettings(page)
  const builtin = page.getByRole('radiogroup', { name: 'AI 运行在哪里' }).getByRole('radio', { name: /本机内置/ })
  await expect(builtin).toBeDisabled()
  await expect(builtin).toContainText('需要 macOS 桌面版')
})

test('本机内置：选择即生效 → 录完再下模型 → 下载完成自动整理', async ({ page }) => {
  test.setTimeout(60_000)
  await page.addInitScript(() => {
    localStorage.setItem('builtin_mock', '1')
    localStorage.removeItem('builtin_mock_ready')
    localStorage.removeItem('builtin_mock_fail')
  })
  await page.goto(BASE)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.kv.put({ key: 'onboarding_done_v1', value: true })
  })
  await openSettings(page)

  // 1) 选择本机内置：立即生效（不用点保存），数据去向全部本机
  await page.getByRole('radiogroup', { name: 'AI 运行在哪里' }).getByRole('radio', { name: /本机内置/ }).click()
  await expect(page.getByText('已切到本机内置模型')).toBeVisible()
  await expect(page.getByLabel('数据去向')).toContainText('会议内容全部留在本机')
  const saved = await page.evaluate(async () => (await import('/src/db/settings.ts')).getSettings())
  expect([saved.ai_mode, saved.asr_mode]).toEqual(['builtin', 'builtin'])

  // 2) 模型未下载时录完一场：不是「失败」，而是「等待模型」
  const id = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const ts = new Date().toISOString()
    const id = crypto.randomUUID()
    await db.meetings.put({ id, title: '周会', status: 'processing', started_at: ts, ended_at: ts, source: 'manual', created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0, audio: { duration_ms: 9000, size_bytes: 3, format: 'audio/webm', chunk_count: 1, chunks_dirty: false } } as never)
    await db.audioChunks.put({ id: crypto.randomUUID(), meeting_id: id, seq: 1, blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), size_bytes: 3, duration_ms: 9000, created_at: ts } as never)
    await (await import('/src/pipeline/transcribe.ts')).runTranscribePipeline(id)
    ;(window as unknown as { __uiStore: { getState: () => { goMeeting: (id: string) => void } } }).__uiStore.getState().goMeeting(id)
    return id
  })
  await expect(page.getByText('等待模型')).toBeVisible()
  await page.getByRole('button', { name: '去下载模型' }).click()

  // 3) 一键下载（显示总大小）→ 进度 → 完成后会议自动整理
  await page.getByRole('button', { name: /^下载（5\.7 GB）$/ }).click()
  await expect(page.getByText('下载本地模型')).toBeVisible() // 侧栏进度
  await expect(page.getByText('✓ 本地模型已就绪，可以离线使用。')).toBeVisible({ timeout: 15_000 })

  await expect.poll(async () => page.evaluate(async (id) => {
    const { db } = await import('/src/db/db.ts')
    const m = await db.meetings.get(id)
    const todos = await db.todos.where('meeting_id').equals(id).count()
    return `${m?.status}/${m?.note_id ? 'note' : '-'}/${todos}`
  }, id), { timeout: 15_000 }).toBe('summarized/note/1')
})
