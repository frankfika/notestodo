# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/smoke.spec.ts >> Shibei shell smoke >> ⌘K 命令面板可打开
- Location: tests/smoke.spec.ts:36:3

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/
Call log:
  - navigating to "http://127.0.0.1:5173/", waiting until "load"

```

# Test source

```ts
  1   | /**
  2   |  * Shibei · 端到端 smoke test
  3   |  *
  4   |  * 用 playwright + 真实 Chromium 浏览器，验证：
  5   |  *   1. 首页加载并显示侧栏 + Today
  6   |  *   2. ⌘K 唤出命令面板
  7   |  *   3. 所有一级页面（会议/笔记/待办/模板）能加载且无运行时报错
  8   |  *   4. 创建一条 Note 后列表出现
  9   |  *   5. ⌘⇧R 录音热键不会让浏览器栈崩（无麦克风授权时 engine 进入 error 态）
  10  |  *
  11  |  * 运行（先启动 dev server）：
  12  |  *   pnpm dev & sleep 4 && SHIBEI_URL=http://127.0.0.1:5173 \
  13  |  *     node node_modules/@playwright/test/cli.js test tests/smoke.spec.ts
  14  |  */
  15  | import { test, expect } from '@playwright/test'
  16  | 
  17  | const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'
  18  | 
  19  | async function dismissOnboarding(page: import('@playwright/test').Page): Promise<void> {
  20  |   // 首次启动会显示右下角引导卡片；点 X 关掉（不阻塞主 UI）
  21  |   const onboardingClose = page.locator('button[aria-label="关闭"]').first()
  22  |   if (await onboardingClose.isVisible({ timeout: 1500 }).catch(() => false)) {
  23  |     await onboardingClose.click()
  24  |   }
  25  | }
  26  | 
  27  | test.describe('Shibei shell smoke', () => {
  28  |   test('首页加载并显示侧栏 + Today', async ({ page }) => {
  29  |     await page.goto(BASE)
  30  |     await dismissOnboarding(page)
  31  |     await expect(page.locator('aside', { hasText: '拾贝' })).toBeVisible()
  32  |     await expect(page.locator('h1', { hasText: '今天' })).toBeVisible()
  33  |     await page.screenshot({ path: 'tests/screenshots/01-today.png', fullPage: true })
  34  |   })
  35  | 
  36  |   test('⌘K 命令面板可打开', async ({ page }) => {
> 37  |     await page.goto(BASE)
      |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/
  38  |     await dismissOnboarding(page)
  39  |     // 显式 focus 到 body 再按热键
  40  |     await page.locator('body').click({ position: { x: 10, y: 10 } })
  41  |     await page.keyboard.press('Meta+k')
  42  |     await expect(page.locator('input[placeholder*="搜索"]')).toBeVisible({ timeout: 5000 })
  43  |     await page.screenshot({ path: 'tests/screenshots/02-cmdk.png' })
  44  |     await page.keyboard.press('Escape')
  45  |     await expect(page.locator('input[placeholder*="搜索"]')).toBeHidden({ timeout: 2000 })
  46  |   })
  47  | 
  48  |   test('所有一级页面可加载（无运行时报错）', async ({ page }) => {
  49  |     await page.goto(BASE)
  50  |     await dismissOnboarding(page)
  51  |     const errors: string[] = []
  52  |     page.on('pageerror', (e) => errors.push(e.message))
  53  |     for (const label of ['会议', '笔记', '待办', '模板']) {
  54  |       await page.getByRole('button', { name: label }).click()
  55  |       await page.waitForTimeout(200)
  56  |     }
  57  |     await expect(errors, errors.join('\n')).toHaveLength(0)
  58  |   })
  59  | 
  60  |   test('创建一条 Note 后列表出现', async ({ page }) => {
  61  |     await page.goto(BASE)
  62  |     await dismissOnboarding(page)
  63  |     await page.getByRole('button', { name: '笔记' }).click()
  64  |     // 顶部 "+ 新建笔记" 按钮
  65  |     const topNew = page.getByRole('button', { name: '+ 新建笔记' }).first()
  66  |     await topNew.waitFor({ state: 'visible', timeout: 5000 })
  67  |     await topNew.click()
  68  |     // 进入 NoteDetail，等待详情页加载
  69  |     await page.locator('button[aria-label="返回"]').first().waitFor({ state: 'visible', timeout: 5000 })
  70  |     await page.locator('button[aria-label="返回"]').first().click()
  71  |     await expect(page.locator('text=未命名笔记').first()).toBeVisible({ timeout: 5000 })
  72  |     await page.screenshot({ path: 'tests/screenshots/03-notes.png', fullPage: true })
  73  |   })
  74  | 
  75  |   test('⌘⇧R 录音热键：engine 切到 error 态（无麦克风授权时）', async ({ page }) => {
  76  |     await page.goto(BASE)
  77  |     await dismissOnboarding(page)
  78  |     await page.context().clearPermissions()
  79  |     await page.keyboard.press('Meta+Shift+r')
  80  |     await page.waitForTimeout(800)
  81  |     await expect(page.locator('aside', { hasText: '拾贝' })).toBeVisible()
  82  |   })
  83  | 
  84  |   test('新建一个 Objective 时 持久化到 IndexedDB', async ({ page }) => {
  85  |     await page.goto(BASE)
  86  |     await dismissOnboarding(page)
  87  |     await page.getByRole('button', { name: '待办' }).click()
  88  |     await page.waitForTimeout(300)
  89  | 
  90  |     const newBtn = page.getByRole('button', { name: /新建 Objective/ }).first()
  91  |     await newBtn.waitFor({ state: 'visible', timeout: 5000 })
  92  |     const beforeCount = await page.evaluate(async () => {
  93  |       return new Promise<number>((res) => {
  94  |         const req = indexedDB.open('shibei')
  95  |         req.onsuccess = () => {
  96  |           const db = req.result
  97  |           const tx = db.transaction('todos', 'readonly')
  98  |           const cr = tx.objectStore('todos').count()
  99  |           cr.onsuccess = () => res(cr.result)
  100 |         }
  101 |         req.onerror = () => res(-1)
  102 |       })
  103 |     })
  104 |     await newBtn.click()
  105 |     await page.waitForTimeout(800)
  106 |     const afterCount = await page.evaluate(async () => {
  107 |       return new Promise<number>((res) => {
  108 |         const req = indexedDB.open('shibei')
  109 |         req.onsuccess = () => {
  110 |           const db = req.result
  111 |           const tx = db.transaction('todos', 'readonly')
  112 |           const cr = tx.objectStore('todos').count()
  113 |           cr.onsuccess = () => res(cr.result)
  114 |         }
  115 |         req.onerror = () => res(-1)
  116 |       })
  117 |     })
  118 |     expect(afterCount).toBe(beforeCount + 1)
  119 |     // 新建的 Objective 应该出现在页面上
  120 |     await expect(page.locator('text=新工作目标').first()).toBeVisible({ timeout: 3000 })
  121 |   })
  122 | 
  123 |   test('未录音时音频条不应出现（idle 状态下 DOM 不渲染）', async ({ page }) => {
  124 |     await page.goto(BASE)
  125 |     await dismissOnboarding(page)
  126 |     // 录音条的容器在 idle 时返回 null — RecordingBar 整体不挂载
  127 |     const bar = page.locator('span.rec-dot').first()
  128 |     await expect(bar).toHaveCount(0)
  129 |   })
  130 | 
  131 |   test('首次用户动作自动关闭 onboarding（AI-native 信号：无需再手把手）', async ({ page }) => {
  132 |     await page.goto(BASE)
  133 |     // 不要 dismiss — 让 onboarding 第一次显示
  134 |     // 触发第一个真实动作 — 创建 Objective
  135 |     await page.getByRole('button', { name: '待办' }).click()
  136 |     await page.waitForTimeout(300)
  137 |     const newBtn = page.getByRole('button', { name: /新建 Objective/ }).first()
```