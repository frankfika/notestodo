# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests/smoke.spec.ts >> Shibei shell smoke >> PWA manifest / index.html、icons、sw 均可响应
- Location: tests/smoke.spec.ts:157:3

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/
Call log:
  - navigating to "http://127.0.0.1:5173/", waiting until "load"

```

# Test source

```ts
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
  138 |     await newBtn.waitFor({ state: 'visible', timeout: 5000 })
  139 |     await newBtn.click()
  140 |     await page.waitForTimeout(800)
  141 |     // onboarding 卡片应该自动消失
  142 |     const onboardingCard = page.locator('text=欢迎使用拾贝').first()
  143 |     await expect(onboardingCard).toHaveCount(0, { timeout: 2000 })
  144 |   })
  145 | 
  146 |   test('快捷键提示跟随平台（mac=⌘ / 其他=⌃）', async ({ page }) => {
  147 |     // Playwright 在 macOS 跑 → navigator.platform 含 'mac'，应输出 ⌘
  148 |     await page.goto(BASE)
  149 |     await dismissOnboarding(page)
  150 |     const isMac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform))
  151 |     const expected = isMac ? '⌘' : '⌃'
  152 |     // Topbar 上 ⌘K 按钮里有正确的符号
  153 |     const topbar = await page.locator('button:has(span.kbd)').first().innerText()
  154 |     expect(topbar).toContain(expected)
  155 |   })
  156 | 
  157 |   test('PWA manifest / index.html、icons、sw 均可响应', async ({ page }) => {
> 158 |     await page.goto(BASE)
      |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/
  159 |     for (const p of [
  160 |       '/manifest.webmanifest',
  161 |       '/sw.js',
  162 |       '/icons/icon-192.png',
  163 |       '/icons/icon-512.png',
  164 |       '/icons/apple-touch-icon.png',
  165 |     ]) {
  166 |       const res = await page.request.get(BASE.replace(/\/$/, '') + p)
  167 |       expect(res.status(), `${p} should be 200`).toBe(200)
  168 |     }
  169 |     // manifest 解析合法 + name/start_url/display 正确
  170 |     const m = await page.request.get(BASE.replace(/\/$/, '') + '/manifest.webmanifest')
  171 |     const json = (await m.json()) as Record<string, unknown>
  172 |     expect(json.name).toBeTruthy()
  173 |     expect(json.start_url).toBe('/')
  174 |     expect(json.display).toBe('standalone')
  175 |     expect(Array.isArray(json.icons)).toBe(true)
  176 |   })
  177 | })
```