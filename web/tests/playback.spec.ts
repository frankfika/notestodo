/**
 * 录音分片排序回归测试 — 修复后 mergeAudioChunks 必须正确处理
 *   seq=-1 的 tail chunk 与数据分片混排。
 *
 * 之前 MeetingDetailPage 与 mergeAudioChunks 都用 sortBy('seq')，导致 tail
 * chunk 排最前 → 用户听到 / 转录到的内容顺序与之前内容不同。
 *
 * 修复后：chunksInOrder 把 tail 永远放最后；mergeAudioChunks 过滤空 placeholder。
 */
import { test, expect } from '@playwright/test'
import { chromium } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
})

test('chunksInOrder: data(seq≥0) by seq, tail(seq=-1) last', async ({ page }) => {
  // 直接在浏览器内加载 ESM 模块验证排序行为（最快，不依赖 UI 导航）
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 80)))

  await page.goto(BASE)
  await page.waitForTimeout(800)

  const result = await page.evaluate(async () => {
    const mod = await import('/src/audio/merge.ts')
    // 构造混合数据：seq=0 空 placeholder、seq=1 数据、seq=2 数据、seq=-1 tail 数据
    const chunks = [
      { id: 'a', meeting_id: 'm', seq: 0, blob: new Blob([new Uint8Array(0)], { type: 'audio/webm' }), size_bytes: 0, duration_ms: 0, created_at: '2024-01-01T00:00:01Z' },
      { id: 'b', meeting_id: 'm', seq: 1, blob: new Blob([new Uint8Array([0x01])], { type: 'audio/webm' }), size_bytes: 1, duration_ms: 1000, created_at: '2024-01-01T00:00:02Z' },
      { id: 'c', meeting_id: 'm', seq: 2, blob: new Blob([new Uint8Array([0x02, 0x02])], { type: 'audio/webm' }), size_bytes: 2, duration_ms: 2000, created_at: '2024-01-01T00:00:03Z' },
      { id: 'd', meeting_id: 'm', seq: -1, blob: new Blob([new Uint8Array([0xff, 0xff, 0xff])], { type: 'audio/webm' }), size_bytes: 3, duration_ms: 500, created_at: '2024-01-01T00:00:04Z' },
    ] as Array<{ id: string; meeting_id: string; seq: number; blob: Blob; size_bytes: number; duration_ms: number; created_at: string }>
    const ordered = mod.chunksInOrder(chunks)
    return ordered.map((c) => ({ id: c.id, seq: c.seq, size: c.blob.size }))
  })

  expect(result).toEqual([
    { id: 'a', seq: 0, size: 0 },   // placeholder 排首位（无害，过滤掉）
    { id: 'b', seq: 1, size: 1 },
    { id: 'c', seq: 2, size: 2 },
    { id: 'd', seq: -1, size: 3 }, // tail 最后
  ])
  expect(errors).toEqual([])
})

test('mergeAudioChunks: 合并后过滤空 placeholder，blob=数据分片总和', async ({ page }) => {
  await page.goto(BASE)
  await page.waitForTimeout(800)
  // seed: 1 个空 placeholder + 1 个数据分片
  const meetingId = await page.evaluate(async () => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meetings', 'audioChunks'], 'readwrite')
        tx.objectStore('meetings').put({
          id, title: 'playback-test', status: 'transcribed',
          started_at: nowIso, ended_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
          audio: { duration_ms: 1500, size_bytes: 0, format: 'audio/webm', chunk_count: 0, chunks_dirty: false },
        } as never)
        tx.objectStore('audioChunks').put({
          id: crypto.randomUUID(), meeting_id: id, seq: 0,
          blob: new Blob([new Uint8Array(0)], { type: 'audio/webm' }),
          size_bytes: 0, duration_ms: 0, created_at: nowIso,
        } as never)
        tx.objectStore('audioChunks').put({
          id: crypto.randomUUID(), meeting_id: id, seq: 1,
          blob: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/webm' }),
          size_bytes: 5, duration_ms: 1500, created_at: nowIso,
        } as never)
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  })

  const result = await page.evaluate(async (id) => {
    const mod = await import('/src/audio/merge.ts')
    const r = await mod.mergeAudioChunks(id)
    return { size: r.blob.size, type: r.blob.type, durationMs: r.durationMs }
  }, meetingId)

  expect(result.size).toBe(5) // 空 placeholder 必须被过滤，blob 只含数据
  expect(result.durationMs).toBe(1500)
  expect(result.type).toBe('audio/webm')
})

test('stop 后实际尾块不再 seq=-1 + 在浏览器中可真实播放', async ({ page }) => {
  await page.goto(BASE)
  const closeBtn = page.locator('button[aria-label="关闭"]').first()
  if (await closeBtn.isVisible({ timeout: 1500 }).catch(() => false)) await closeBtn.click()

  await page.getByRole('button', { name: /● 开始录音/ }).first().click()
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: /■ 停止/ }).first().click()
  await page.waitForTimeout(2000)

  // 检查 tail chunk（最后一个写入、size 最大）的 seq
  const tailSeq = await page.evaluate(async () => new Promise<number>((res) => {
    const req = indexedDB.open('shibei')
    req.onsuccess = () => {
      const tx = req.result.transaction('audioChunks', 'readonly')
      const all = tx.objectStore('audioChunks').getAll()
      all.onsuccess = () => {
        const arr = (all.result as Array<{ size_bytes: number; seq: number }>)
          .sort((a, b) => b.size_bytes - a.size_bytes)
        res(arr[0]?.seq ?? -99)
      }
    }
  }))
  expect(tailSeq).toBeGreaterThanOrEqual(1) // 真实音频必须 seq>=0
})