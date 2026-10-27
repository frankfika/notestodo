/**
 * 笔记块编辑器（TipTap）e2e — 需求：Notion 风格块编辑
 *
 * 覆盖：
 *   1. Markdown 双向转换：种子 body_md（标题/列表/引用/代码/任务列表/分割线）
 *      → 编辑器块渲染正确 → 重新打开仍在（round-trip 稳定）
 *   2. 编辑 → 400ms debounce 落库 → 刷新页面重开仍在
 *   3. 斜杠菜单：键入 / 唤起，筛选 h1，回车插入标题块
 *   4. 块手柄：点击选中块（NodeSelection）；拖动移动块顺序 → 落库
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function seedNote(page: Page, bodyMd: string, title = '编辑器测试笔记'): Promise<string> {
  return page.evaluate(async ({ bodyMd, title }) => {
    const id = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    await new Promise<void>((res, rej) => {
      const req = indexedDB.open('shibei')
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['notes'], 'readwrite')
        tx.objectStore('notes').put({
          id, title, body_md: bodyMd, pinned: false, todo_ids: [],
          created_at: nowIso, updated_at: nowIso, deleted_at: null, sync_version: 0,
        })
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      }
    })
    return id
  }, { bodyMd, title })
}

async function openNote(page: Page, id: string): Promise<void> {
  await page.evaluate((nid) => {
    const ui = (window as unknown as { __uiStore?: { getState: () => { goNote: (id: string) => void } } }).__uiStore
    ui?.getState().goNote(nid)
  }, id)
}

async function readBodyMd(page: Page, id: string): Promise<string> {
  return page.evaluate(async (nid) => new Promise<string>((res, rej) => {
    const req = indexedDB.open('shibei')
    req.onerror = () => rej(new Error('idxb'))
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['notes'], 'readonly')
      const n = tx.objectStore('notes').get(nid)
      n.onsuccess = () => res((n.result as { body_md: string }).body_md)
      setTimeout(() => rej(new Error('readback-timeout')), 5_000)
    }
  }), id)
}

const RICH_MD = [
  '# 大标题',
  '',
  '## 小节',
  '',
  '- 苹果',
  '- 香蕉',
  '',
  '1. 第一步',
  '2. 第二步',
  '',
  '> 一句引用',
  '',
  '```',
  'const x = 1',
  '```',
  '',
  '- [ ] 未完成任务',
  '- [x] 已完成任务',
  '',
  '---',
  '',
  '结尾段落',
].join('\n')

test.describe('笔记块编辑器', () => {
  test('Markdown 双向转换：种子 body_md 渲染成块，重开 round-trip 稳定', async ({ page }) => {
    test.setTimeout(45_000)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    const x = page.locator('button[aria-label="关闭"]').first()
    if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

    const noteId = await seedNote(page, RICH_MD)
    await openNote(page, noteId)
    await page.waitForTimeout(800)

    const ed = page.locator('.note-editor .ProseMirror')
    await expect(ed).toBeVisible({ timeout: 5_000 })
    // 块渲染
    await expect(ed.locator('h1')).toHaveText('大标题')
    await expect(ed.locator('h2')).toHaveText('小节')
    await expect(ed.locator('ul:not([data-type="taskList"]) li')).toHaveCount(2)
    await expect(ed.locator('ol li')).toHaveCount(2)
    await expect(ed.locator('blockquote')).toContainText('一句引用')
    await expect(ed.locator('pre')).toContainText('const x = 1')
    await expect(ed.locator('ul[data-type="taskList"] li')).toHaveCount(2)
    await expect(ed.locator('ul[data-type="taskList"] li[data-checked="true"]')).toHaveCount(1)
    await expect(ed.locator('hr')).toHaveCount(1)

    // 不编辑 → 不应产生落库（round-trip 序列化与种子一致）
    await page.waitForTimeout(600)
    expect(await readBodyMd(page, noteId)).toBe(RICH_MD)

    // 刷新重开 → 仍在
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(600)
    await openNote(page, noteId)
    await page.waitForTimeout(800)
    await expect(ed.locator('h1')).toHaveText('大标题')
    await expect(ed.locator('ul[data-type="taskList"] li')).toHaveCount(2)
  })

  test('编辑 → debounce 落库 → 刷新重开仍在', async ({ page }) => {
    test.setTimeout(45_000)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    const x = page.locator('button[aria-label="关闭"]').first()
    if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

    const noteId = await seedNote(page, '')
    await openNote(page, noteId)
    await page.waitForTimeout(800)

    const ed = page.locator('.note-editor .ProseMirror').first()
    await ed.click()
    await page.keyboard.type('第一段中文输入')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.type('第二段 with English')

    await page.waitForTimeout(800) // debounce 400ms
    const saved = await readBodyMd(page, noteId)
    expect(saved).toContain('第一段中文输入')
    expect(saved).toContain('第二段 with English')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(600)
    await openNote(page, noteId)
    await page.waitForTimeout(800)
    const ed2 = page.locator('.note-editor .ProseMirror')
    await expect(ed2).toContainText('第一段中文输入')
    await expect(ed2).toContainText('第二段 with English')
  })

  test('斜杠菜单：/ 唤起 → 筛选 → 回车插入标题块', async ({ page }) => {
    test.setTimeout(45_000)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    const x = page.locator('button[aria-label="关闭"]').first()
    if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

    const noteId = await seedNote(page, '')
    await openNote(page, noteId)
    await page.waitForTimeout(800)

    const ed = page.locator('.note-editor .ProseMirror')
    await ed.click()
    await page.keyboard.type('/')
    const menu = page.locator('.slash-menu')
    await expect(menu).toBeVisible({ timeout: 3_000 })
    await expect(menu.locator('button')).toHaveCount(10)

    await page.keyboard.type('h1')
    await page.waitForTimeout(300)
    await expect(menu.locator('button')).toHaveCount(1)
    await expect(menu.locator('button').first()).toContainText('一级标题')

    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await page.keyboard.type('斜杠创建的大标题')
    await page.waitForTimeout(800)

    await expect(ed.locator('h1')).toHaveText('斜杠创建的大标题')
    const saved = await readBodyMd(page, noteId)
    expect(saved).toContain('# 斜杠创建的大标题')
  })

  test('块手柄：点击选中块，拖动调换两个段落的顺序并落库', async ({ page }) => {
    test.setTimeout(45_000)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    const x = page.locator('button[aria-label="关闭"]').first()
    if (await x.isVisible({ timeout: 1500 }).catch(() => false)) await x.click()

    const noteId = await seedNote(page, '第一段内容\n\n第二段内容')
    await openNote(page, noteId)
    await page.waitForTimeout(800)

    const ed = page.locator('.note-editor .ProseMirror')
    await expect(ed).toContainText('第一段内容')

    // 悬停第一段 → 手柄出现（定位到该块）
    const firstP = ed.locator('p', { hasText: '第一段内容' })
    await firstP.hover()
    const handle = page.locator('.block-handle')
    await expect(handle).toBeVisible({ timeout: 3_000 })

    // 点击手柄（不拖动）→ NodeSelection，块高亮
    await handle.click({ force: true })
    await page.waitForTimeout(200)
    await expect(ed.locator('.ProseMirror-selectednode')).toHaveCount(1)

    // 拖动手柄 → 第二段中段（下半区 = 放它后面）
    // Playwright 真实鼠标不保证触发 HTML5 drag（与 okr-tree-ux 同款问题），
    // 这里走合成 DragEvent，和应用内的 dragstart/dragover/drop 处理器同一条路径。
    const hb = await handle.boundingBox()
    const fb = await firstP.boundingBox()
    const secondP = ed.locator('p', { hasText: '第二段内容' })
    const tb = await secondP.boundingBox()
    if (!hb || !fb || !tb) throw new Error('no box')
    await page.evaluate(({ hx, hy, fx, fy, tx, ty }) => {
      const wrap = document.querySelector('.note-editor') as HTMLElement
      const handleEl = wrap.querySelector('.block-handle') as HTMLElement
      const dt = new DataTransfer()
      const fire = (el: Element, type: string, x: number, y: number) =>
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
      // 先补一次 mousemove 让 hoverBlock 指向第一段（dragstart 读它定位源块）
      wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: fx, clientY: fy }))
      fire(handleEl, 'dragstart', hx, hy)
      fire(wrap, 'dragover', tx, ty)
      fire(wrap, 'dragover', tx, ty)
      fire(wrap, 'drop', tx, ty)
      fire(handleEl, 'dragend', hx, hy)
    }, { hx: hb.x + hb.width / 2, hy: hb.y + hb.height / 2, fx: fb.x + 10, fy: fb.y + 5, tx: tb.x + tb.width / 2, ty: tb.y + tb.height - 3 })
    await page.waitForTimeout(800) // update + debounce

    const saved = await readBodyMd(page, noteId)
    expect(saved.indexOf('第二段内容')).toBeLessThan(saved.indexOf('第一段内容'))

    // 界面上也交换了
    const texts = await ed.locator('p').allInnerTexts()
    expect(texts.indexOf('第二段内容')).toBeLessThan(texts.indexOf('第一段内容'))
  })
})
