/**
 * 采集用 Playwright 环境：Chromium 启动参数、context/page、播种、导航、截图、录屏。
 *
 * 复用 web/tests/*.spec.ts 既有做法：
 *   - 假麦克风       : --use-fake-device-for-media-stream / --use-fake-ui-for-media-stream（recording.spec.ts）
 *   - 播种           : 页面内 `await import('/src/db/db.ts')` 直接写 Dexie（okr-tree-ux.spec.ts）
 *   - 关引导浮层     : kv onboarding_done_v1 = true（onboarding-auto-dismiss / 各 spec 的关闭按钮）
 *   - 导航           : window.__uiStore（state/ui.ts DEV 钩子）
 */
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSeed, writeSeedArchives } from './seed.mjs'
import { ensureFakeMicWav } from './fake-mic.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '../../../..') // repo root
export const PROMO = path.join(ROOT, 'promo')
export const CAPTURE = path.join(PROMO, 'capture')
export const STILLS = path.join(CAPTURE, 'stills')
export const CLIPS = path.join(CAPTURE, 'clips')
export const SEED_DIR = path.join(CAPTURE, 'seed')
const VIDEO_TMP = path.join(CAPTURE, '.video-tmp')

const require = createRequire(path.join(ROOT, 'web', 'package.json'))
const { chromium } = require('@playwright/test')

export const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

export const DESKTOP = { width: 1920, height: 1080 }
export const MOBILE = { width: 390, height: 844 }
export const IPAD = { width: 1366, height: 1024 }
/** iPad 竖版：768x1024 @2 = 1536x2048，正好 3:4，与品牌 tablet-frame 内屏 612x816 同比例 */
export const IPAD_PORTRAIT = { width: 768, height: 1024 }

/** 输出名后缀（例：CAPTURE_SUFFIX=-clean 出一套隐藏浏览器能力提示条的版本） */
export const SUFFIX = process.env.CAPTURE_SUFFIX ?? ''

// ── 页面侧注入脚本 ──────────────────────────────────────────────────────────

/**
 * 假麦克风：Chromium 用合成音频源喂 getUserMedia，录音条/电平条会真的动。
 * --use-file-for-fake-audio-capture 指向自研的类人声 WAV —— 内置 fake device 只在
 * 开头几秒有声，电平条会趴平（见 lib/fake-mic.mjs 的说明）。
 */
const FAKE_MEDIA_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]

/**
 * 浏览器实时字幕桩：无头 Chromium 不带厂商语音识别（webkitSpeechRecognition 不存在），
 * 用同样的 SR 接口喂脚本化结果 —— 走的是产品真实的 liveCaption.ts 代码路径
 * （useCaption store + kv live_caption_<id> + 面板滚动）。
 */
const CAPTION_LINES = [
  '今天主要定 Q4 的路线优先级。',
  '先过一遍手上的候选，然后决定砍掉哪些。',
  '我最担心的是中文转录质量。',
  '上周那场客户访谈，转录把「拾贝」识别成了「十倍」。',
  '热词表已经在做了，把产品名、人名、专有名词塞进去。',
  '转录请求里带上 hotwords，能救回来一大半。',
  '那就按「先热词、再说话人区分」来排。',
  '说话人区分我接了中文声纹，能标出说话人 1、2、3。',
]

const SR_STUB = `(() => {
  const LINES = ${JSON.stringify(CAPTION_LINES)}
  class FakeSR {
    constructor() {
      this.lang = 'zh-CN'; this.continuous = true; this.interimResults = true
      this.onresult = null; this.onerror = null; this.onend = null
      this._timers = []; this._i = 0
    }
    start() {
      if (this._timers.length) return
      const pace = Number(window.__srPace) || 620
      let t = Math.max(400, Math.round(pace * 0.8))
      for (let i = 0; i < LINES.length; i++) {
        const text = LINES[i]
        // 先说半句（interim），再落定整句（final）
        const head = text.slice(0, Math.max(2, Math.floor(text.length * 0.55)))
        this._timers.push(setTimeout(() => this._emit(head, false), t))
        this._timers.push(setTimeout(() => this._emit(text, true), t + Math.round(pace * 0.4)))
        t += pace
      }
    }
    _emit(text, isFinal) {
      if (!this.onresult) return
      const r = [{ transcript: text }]
      r.isFinal = isFinal
      this.onresult({ resultIndex: 0, results: [r] })
    }
    stop() { this._timers.forEach(clearTimeout); this._timers = [] }
    abort() { this.stop() }
  }
  window.SpeechRecognition = FakeSR
  window.webkitSpeechRecognition = FakeSR
})()`

/** LLM 拦截：走真实的 runSummarizePipeline，只把网络换成确定性的纪要 JSON */
const LLM_STUB = (json, delayMs) => `(() => {
  const PAYLOAD = ${JSON.stringify(JSON.stringify(json))}
  const DELAY = ${delayMs}
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input)
    if (url.includes('/chat/completions') || url.includes('/v1/messages')) {
      await new Promise((r) => setTimeout(r, DELAY))
      return new Response(JSON.stringify({
        id: 'chatcmpl-capture', object: 'chat.completion', model: 'MiniMax-M2.7',
        choices: [{ index: 0, message: { role: 'assistant', content: PAYLOAD }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2140, completion_tokens: 612, total_tokens: 2752 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return realFetch(input, init)
  }
})()`

/**
 * 引导浮层守卫：Onboarding 的首帧 `onboardingRow` 还是 undefined，所以
 * 「拾贝 · 新用户引导」面板会先渲染一帧才被 liveQuery（onboarding_done_v1=true）关掉。
 * 截图/录屏都不能出现引导浮层，这里在 MutationObserver 里把它按掉 ——
 * 效果等同于用户点了面板上的 ✕（产品本来就允许），只是把那一帧竞态消掉。
 */
const ONBOARDING_GUARD = `(() => {
  const kill = () => {
    for (const el of document.querySelectorAll('[role="dialog"]')) {
      if ((el.textContent || '').includes('新用户引导')) el.style.display = 'none'
    }
  }
  const start = () => {
    kill()
    const obs = new MutationObserver(kill)
    obs.observe(document.documentElement, { childList: true, subtree: true })
    setTimeout(() => { obs.disconnect(); kill() }, 5000)
  }
  if (document.documentElement) start()
  else document.addEventListener('DOMContentLoaded', start)
})()`

/**
 * 采集期默认**保留**浏览器里那条「系统声音需桌面版」的诚实 banner ——
 * 产品原则是不假装成功，成片也不该把它抹掉。只有显式设 HIDE_CAPTURE_BANNER=1
 * 时才隐藏（供 lead/brand 需要干净底图时选用，产出 *-clean 素材）。
 */
const HIDE_CAPTURE_BANNER = `(() => {
  const hide = () => {
    for (const el of document.querySelectorAll('main > div.border-b > div')) {
      if ((el.textContent || '').includes('浏览器中只能录制麦克风')) el.style.display = 'none'
    }
  }
  hide()
  setInterval(hide, 200)
})()`

// ── 播种 ────────────────────────────────────────────────────────────────────

const SEED_FN = async ({ seed }) => {
  const { db } = await import('/src/db/db.ts')

  /**
   * 静音 WAV 分片：让会议的「录音回放」有真实可播、总时长正确的音频，
   * 而且片数与 meeting.audio.chunk_count（5 分钟一片）一致 ——
   * 第 0 片带 RIFF 头（data size 声明为整段长度），其余片是裸 PCM，
   * 拼接后仍是一个合法的完整 WAV。
   */
  const wavHeader = (totalBytes, sampleRate) => {
    const buf = new ArrayBuffer(44)
    const dv = new DataView(buf)
    const w = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); dv.setUint32(4, 36 + totalBytes, true); w(8, 'WAVE'); w(12, 'fmt ')
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate, true)
    dv.setUint16(32, 1, true); dv.setUint16(34, 8, true)
    w(36, 'data'); dv.setUint32(40, totalBytes, true)
    return new Uint8Array(buf)
  }

  const chunkBlobs = (seconds, parts, sampleRate = 8000) => {
    const total = Math.max(1, Math.round(seconds * sampleRate))
    const per = Math.floor(total / parts)
    const out = []
    for (let i = 0; i < parts; i++) {
      const n = i === parts - 1 ? total - per * (parts - 1) : per
      const data = new Uint8Array(n).fill(128)
      out.push(i === 0
        ? new Blob([wavHeader(total, sampleRate), data], { type: 'audio/wav' })
        : new Blob([data], { type: 'audio/wav' }))
    }
    return out
  }

  const tables = ['meetings', 'audioChunks', 'transcripts', 'notes', 'summaries', 'templates',
    'todos', 'tags', 'tagBindings', 'chatMessages', 'queueJobs', 'kv', 'knowledgeEntries',
    'pinnedAssistCards', 'scribbles']
  await Promise.all(tables.map((t) => db[t].clear()))

  await db.meetings.bulkPut(seed.meetings)
  await db.notes.bulkPut(seed.notes)
  await db.summaries.bulkPut(seed.summaries)
  await db.transcripts.bulkPut(seed.transcripts)
  await db.scribbles.bulkPut(seed.scribbles)
  await db.todos.bulkPut(seed.todos)
  await db.templates.bulkPut(seed.templates)
  await db.tags.bulkPut(seed.tags)
  await db.tagBindings.bulkPut(seed.tagBindings)
  await db.knowledgeEntries.bulkPut(seed.knowledgeEntries)
  await db.pinnedAssistCards.bulkPut(seed.pinnedAssistCards)

  const nowIso = new Date().toISOString()
  for (const [key, value] of Object.entries(seed.kv)) await db.kv.put({ key, value })

  // 每场会议：按 chunk_count 写入分片，拼接后是总时长正确的可播 WAV
  let chunks = 0
  for (const m of seed.meetings) {
    const seconds = seed.audio_seconds[m.id] ?? 0
    if (!seconds) continue
    const parts = Math.max(1, m.audio.chunk_count || 1)
    const blobs = chunkBlobs(seconds, parts)
    for (let i = 0; i < parts; i++) {
      await db.audioChunks.put({
        id: `chunk-${m.id}-${i}`, meeting_id: m.id, seq: i, blob: blobs[i],
        size_bytes: blobs[i].size, duration_ms: Math.round(m.audio.duration_ms / parts), created_at: nowIso,
      })
      chunks++
    }
  }
  return { meetings: seed.meetings.length, todos: seed.todos.length, audio: chunks }
}

// ── 浏览器 / 页面 ───────────────────────────────────────────────────────────

export async function launch() {
  await mkdir(VIDEO_TMP, { recursive: true })
  const micWav = await ensureFakeMicWav()
  return chromium.launch({
    args: [...FAKE_MEDIA_ARGS, `--use-file-for-fake-audio-capture=${micWav}`],
  })
}

/**
 * 新建 page。
 * @param {object} o
 * @param {{width:number,height:number}} o.viewport
 * @param {number} o.dsf             deviceScaleFactor
 * @param {boolean} o.recordVideo    是否录屏（size 固定 1920x1080）
 * @param {boolean} o.sr             是否注入实时字幕桩
 * @param {object}  o.llmStub        { json, delayMs } 拦截 LLM
 * @param {boolean} o.seed           是否播种（默认 true）
 */
export async function newPage(browser, o = {}) {
  const {
    viewport = DESKTOP, dsf = 2, recordVideo = false, sr = false,
    llmStub = null, seed = true, name = 'page', initScripts = [], patchSeed = null,
  } = o
  void name

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: dsf,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
    ...(recordVideo ? { recordVideo: { dir: VIDEO_TMP, size: { width: 1920, height: 1080 } } } : {}),
  })

  if (sr) await context.addInitScript(SR_STUB)
  if (llmStub) await context.addInitScript(LLM_STUB(llmStub.json, llmStub.delayMs ?? 900))
  for (const s of initScripts) await context.addInitScript(s)
  await context.addInitScript(ONBOARDING_GUARD)
  if (process.env.HIDE_CAPTURE_BANNER === '1') await context.addInitScript(HIDE_CAPTURE_BANNER)
  // 采集期禁用平滑滚动，避免截图/录屏落在滚动途中
  await context.addInitScript(() => {
    const s = document.createElement('style')
    s.textContent = 'html{scroll-behavior:auto !important}'
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s))
  })

  const page = await context.newPage()
  const seedInfo = seed ? await applySeed(page, patchSeed) : null
  return { context, page, seedInfo }
}

/** goto → 播种 → reload（清掉内存里的 settings 缓存与首帧状态） */
export async function applySeed(page, patchSeed = null) {
  const info = await seedOnly(page, patchSeed)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForApp(page)
  return info
}

/**
 * 只写库，不等应用就绪（给「播种页」用）。
 * 同一 browser context 内 IndexedDB 同源共享，所以先用一个不录制的页把数据写好，
 * 再开真正录制的页 —— 录制页第一帧就是「已有数据」的应用，不会录到引导浮层/空状态。
 */
export async function seedOnly(page, patchSeed = null) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#root > *', { timeout: 20_000 })
  const seed = buildSeed(new Date())
  if (patchSeed) patchSeed(seed)
  const info = await page.evaluate(SEED_FN, { seed })
  return { ...info, seed }
}

export async function waitForApp(page) {
  // 桌面用 aside（≥768px），移动用底部 tab bar；两边都不用「hidden」的那个
  await page.waitForFunction(() => {
    if (!window.__uiStore) return false
    const visible = (sel) => {
      const el = document.querySelector(sel)
      return Boolean(el && el.getClientRects().length)
    }
    return visible('aside') || visible('nav[aria-label="主导航"]')
  }, null, { timeout: 20_000 })
  // 等 liveQuery 首帧落地（引导浮层消失）
  await page.waitForFunction(
    () => !document.body.innerText.includes('欢迎使用拾贝'),
    null, { timeout: 10_000 },
  ).catch(() => undefined)
  await settle(page, 350)
}

/** 双 rAF + 微等待：等布局/字体/动画落定 */
export async function settle(page, ms = 300) {
  await page.waitForTimeout(ms)
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))))
}

// ── 导航（复用 state/ui.ts 的 store 钩子，等价于点侧栏）────────────────────

export async function go(page, view, opts = {}) {
  await page.evaluate(({ view, opts }) => {
    const ui = window.__uiStore.getState()
    if (view === 'meeting-detail') ui.goMeeting(opts.id)
    else if (view === 'note-detail') ui.goNote(opts.id)
    else if (view === 'todos') ui.goTaskMode(opts.mode ?? 'focus')
    else if (view === 'board') ui.goBoard()
    else if (view === 'report') ui.goReport()
    else if (view === 'settings') ui.goSettings()
    else if (view === 'meetings') ui.goMeetings()
    else if (view === 'notes') ui.goNotes()
    else ui.goToday()
  }, { view, opts })
  await settle(page, opts.wait ?? 420)
  // 首次导航落定时刻：record() 据此剪掉开头那段「今天页」闪屏
  page.__clipStart ??= Date.now()
}

/** 点侧栏（真实交互，用于录屏里「用户点了一下」的画面） */
export async function clickNav(page, label) {
  const sides = [page.locator('aside nav button', { hasText: label }),
    page.locator('nav[aria-label="主导航"] button', { hasText: label })]
  for (const l of sides) {
    if (await l.first().isVisible().catch(() => false)) { await l.first().click(); return }
  }
  throw new Error(`nav not found: ${label}`)
}

// ── 截图 ────────────────────────────────────────────────────────────────────

export async function shot(page, name, o = {}) {
  await mkdir(STILLS, { recursive: true })
  await settle(page, o.wait ?? 220)
  if (o.before) await o.before()
  const file = path.join(STILLS, `${name}.png`)
  await page.screenshot({ path: file, caret: 'hide', animations: 'disabled', fullPage: false })
  return file
}

/** 静帧尺寸自检：必须等于 viewport * dsf */
export async function shotExpect(page, name, viewport, dsf, o = {}) {
  const file = await shot(page, name, o)
  return { name, path: path.relative(CAPTURE, file), w: viewport.width * dsf, h: viewport.height * dsf }
}

// ── 录屏 ────────────────────────────────────────────────────────────────────

/**
 * 录一段：fn(page) 里做交互，收尾自动静置 >= 0.8s。
 * 返回 webm 落盘路径 + 实测用不到的元信息（时长由 ffprobe 实测）。
 */
/**
 * 录一段：fn(page) 里做交互，收尾自动静置 >= 1.2s。
 *
 * 录制页是「第二个页」：先在同 context 里用播种页写入 IndexedDB，再开录制页 ——
 * Playwright 的视频是**按页**录的，所以视频从「已有数据的应用加载」开始，
 * 不会录到播种过程中的引导浮层 / 空状态 / reload 闪帧。
 *
 * @returns webm 落盘路径（时长由 ffprobe 实测，不在这里估算）
 */
export async function record(browser, name, viewport, fn, o = {}) {
  await mkdir(CLIPS, { recursive: true })
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
    recordVideo: { dir: VIDEO_TMP, size: { width: 1920, height: 1080 } },
  })
  if (o.sr) await context.addInitScript(SR_STUB)
  if (o.llmStub) await context.addInitScript(LLM_STUB(o.llmStub.json, o.llmStub.delayMs ?? 900))
  for (const s of o.initScripts ?? []) await context.addInitScript(s)
  await context.addInitScript(ONBOARDING_GUARD)
  if (process.env.HIDE_CAPTURE_BANNER === '1') await context.addInitScript(HIDE_CAPTURE_BANNER)
  await context.addInitScript(() => {
    const s = document.createElement('style')
    s.textContent = 'html{scroll-behavior:auto !important}'
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s))
  })

  // ① 播种页（不录用）
  const seeder = await context.newPage()
  await seedOnly(seeder, o.patchSeed ?? null)
  await seeder.close()

  // ② 录制页
  const page = await context.newPage()
  const tOpen = Date.now()
  const video = page.video()
  let err = null
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitForApp(page)
    await fn(page)
  } catch (e) {
    err = e
  }
  await settle(page, o.tail ?? 1200)
  await page.close()
  const src = await video.path()
  await context.close()
  if (!src) throw new Error(`no video for ${name}`)
  const dest = path.join(CLIPS, `${name}.webm`)
  const { rename, copyFile, rm } = await import('node:fs/promises')
  // 先导航再演示的片段：开头会先闪一下「今天页」，剪掉（留 0.25s 余量，此时新页已渲染 ≥170ms）
  const head = page.__clipStart ? Math.max(0, (page.__clipStart - tOpen) / 1000 - 0.25) : 0
  if (head > 0.05) {
    const { execFileSync } = await import('node:child_process')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ss', head.toFixed(3), '-an',
      '-c:v', 'libvpx-vp9', '-crf', '18', '-b:v', '0', '-row-mt', '1', '-deadline', 'good',
      '-cpu-used', '4', dest])
    await rm(src, { force: true })
  } else {
    try { await rename(src, dest) } catch { await copyFile(src, dest); await rm(src, { force: true }) }
  }
  if (err instanceof CleanlinessError) {
    // 清场不合规的产物不能留在 dist 里冒充素材
    await rm(dest, { force: true })
    throw err
  }
  if (err) console.warn(`  ! ${name} 交互中抛错（视频仍已保存）:`, err.message)
  return dest
}

// ── 通用页面操作 ────────────────────────────────────────────────────────────

/** 暴露应用模块到 window，避免在轮询里反复 dynamic import */
export async function exposeModules(page) {
  await page.evaluate(async () => {
    window.__rec = (await import('/src/state/recorder.ts')).useRecorder
    window.__db = (await import('/src/db/db.ts')).db
    window.__ui = (await import('/src/state/ui.ts')).useUI
  })
}

/** 滚动 `.page-enter` 内第一个可滚动容器 */
export async function scrollMain(page, y) {
  await page.evaluate((top) => {
    const root = document.querySelector('.page-enter')
    if (!root) return
    for (const el of root.querySelectorAll('*')) {
      const st = getComputedStyle(el)
      if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20) {
        el.scrollTop = top
        return
      }
    }
  }, y)
  await settle(page, 260)
}

/** 等声音电平到峰值（假麦克风是间歇性蜂鸣，电平条要有幅度才好看） */
export async function waitForLevel(page, min = 0.35, timeout = 8_000) {
  await page.waitForFunction(
    (m) => (window.__rec?.getState().audioLevel ?? 0) >= m,
    min, { timeout, polling: 30 },
  ).catch(() => undefined)
}

/**
 * 合成 HTML5 拖拽：直接派发 DragEvent。
 * 沿用 web/tests/okr-tree-ux.spec.ts 的结论 —— Playwright 真实鼠标拖拽在同一页
 * 第二次会挂住（与应用无关），而派发 DragEvent 约 30ms 就能完成，且走的是
 * 产品真实的 onDragStart / onDragOver / onDrop 处理函数。
 * @param fy 落点在目标元素高度上的比例（OKR 树：<0.25 前 / >0.75 后 / 中间挂进去）
 */
export async function synthDrag(page, fromSel, toSel, fy = 0.5) {
  await page.evaluate(async ({ fromSel, toSel, fy }) => {
    const from = document.querySelector(fromSel)
    const to = document.querySelector(toSel)
    if (!from) throw new Error(`synthDrag: source not found ${fromSel}`)
    if (!to) throw new Error(`synthDrag: target not found ${toSel}`)
    const dt = new DataTransfer()
    const fire = (el, type, frac) => {
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: r.left + r.width / 2,
        clientY: r.top + Math.max(2, r.height * frac),
      }))
    }
    fire(from, 'dragstart', 0.5)
    await new Promise((r) => setTimeout(r, 70))
    fire(to, 'dragover', fy)
    await new Promise((r) => setTimeout(r, 70))
    fire(to, 'drop', fy)
    fire(from, 'dragend', 0.5)
  }, { fromSel, toSel, fy })
}

/** 等一段 DOM 文本出现/消失 */
export async function waitForText(page, text, o = {}) {
  const { present = true, timeout = 15_000 } = o
  await page.waitForFunction(
    ({ text, present }) => document.body.innerText.includes(text) === present,
    { text, present }, { timeout },
  )
}

/** 点击全局「开始录音」，等 phase=recording，返回新会议 id */
export async function startRecording(page) {
  await page.getByRole('button', { name: /● 开始录音/ }).first().click()
  await exposeModules(page)
  await page.waitForFunction(() => window.__rec?.getState().phase === 'recording', null, { timeout: 20_000 })
  return page.evaluate(() => window.__rec.getState().meeting?.id ?? null)
}

/**
 * 给「真跑起来」的录音会议补上真实感内容：标题、速记、固定资料卡。
 * 速记 t_ms 与真实 elapsed 对齐（录到第 N 秒记下第 N 条）。
 */
export async function enrichLiveMeeting(page, meetingId, o) {
  await page.evaluate(async ({ meetingId, title, scribbles, pinned }) => {
    const { db } = await import('/src/db/db.ts')
    if (title) await db.meetings.update(meetingId, { title })
    if (scribbles.length) {
      await db.scribbles.bulkPut(scribbles.map((s, i) => ({
        id: `live-sc-${i}`, meeting_id: meetingId, t_ms: s.t_ms, text: s.text,
        created_at: new Date(Date.now() + i).toISOString(),
      })))
    }
    if (pinned) {
      const ts = new Date().toISOString()
      await db.pinnedAssistCards.put({
        id: `pac-live-${meetingId}`, meeting_id: meetingId,
        source_entry_id: pinned.source_entry_id, title: pinned.title, snippet: pinned.snippet,
        path: pinned.path, created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
      })
    }
  }, { meetingId, title: o.title, scribbles: o.scribbles ?? [], pinned: o.pinned ?? null })
  await settle(page, 300)
}

// ── 清场纪律自检（确定性、可复核）────────────────────────────────────────────
// 视觉复核工具（MiniMax understand_image）本轮配额用尽，所以把「画面里不能出现
// 什么、必须出现什么」落成 DOM 断言，每张静帧 / 每条录屏都跑一遍；失败即采集失败。
export const FORBIDDEN_TEXT = [
  '欢迎使用拾贝', '拾贝 · 新用户引导',                                       // 引导浮层
  '加载中', '正在加载',                                                     // loading
  '还没有', '暂无', '没有匹配', '清空了', '拖卡片到这里',                    // 空状态
  '本周暂无', '本周没有会议', '暂无逾期事项', '下周暂无带截止日的卡片',        // 周报 fallback
  '失败：', '导出失败', '导入失败', '转录失败', '整理失败',                   // 报错
  '没有可播放的录音', '转录尚未完成',
]
export const ZERO_COUNT = /(^|[^0-9])0\s*(条|张|场|个|项|段|片)/
/** -clean 素材额外要求：画面里没有浏览器能力提示条 */
export const BANNER_TEXT = '系统声音需 NotesToGO 桌面版'

export const EMPTY_STATE_PHRASES = ['还没有', '暂无', '没有匹配', '清空了', '拖卡片到这里',
  '本周暂无', '本周没有会议', '暂无逾期事项', '下周暂无带截止日的卡片']
export const ERROR_PHRASES = ['失败：', '导出失败', '导入失败', '转录失败', '整理失败']
export const ONBOARDING_PHRASES = ['欢迎使用拾贝', '拾贝 · 新用户引导']

/**
 * 采集当场记录「画面事实」，供 MANIFEST 逐条引用（不是事后手写的说明）。
 * 包括：路由状态、空状态命中、报错命中、引导浮层命中、0 计数命中、
 * 能力提示条是否在画面里、页面上有哪些置灰项。
 */
export async function collectFacts(page) {
  return page.evaluate(({ empty, err, onb, banner }) => {
    const t = document.body.innerText
    const hit = (arr) => arr.filter((x) => t.includes(x))
    const ui = window.__uiStore?.getState?.() ?? {}
    const disabled = [...document.querySelectorAll('button:disabled, [aria-disabled="true"]')]
      .map((el) => (el.innerText || '').trim().split('\n')[0].slice(0, 40)).filter(Boolean)
    return {
      route: { view: ui.view ?? null, taskMode: ui.taskMode ?? null, meetingId: ui.meetingId ?? ui.activeMeetingId ?? null },
      empty_state_hits: hit(empty),
      error_hits: hit(err),
      onboarding_hits: hit(onb),
      zero_count_hits: (t.match(/(^|[^0-9])0\s*(条|张|场|个|项|段|片)/g) || []).map((x) => x.trim()),
      browser_banner: t.includes(banner),
      disabled_items: [...new Set(disabled)],
      text_len: t.length,
    }
  }, { empty: EMPTY_STATE_PHRASES, err: ERROR_PHRASES, onb: ONBOARDING_PHRASES, banner: BANNER_TEXT })
}

/** 采集事实落盘（静帧/录屏脚本共用，读-改-写合并） */
export const FACTS_FILE = path.join(CAPTURE, '.capture-facts.json')
export async function saveFacts(kind, name, facts) {
  const fs = await import('node:fs/promises')
  let all = { stills: {}, clips: {} }
  try { all = JSON.parse(await fs.readFile(FACTS_FILE, 'utf8')) } catch { /* 首次 */ }
  all[kind] = all[kind] ?? {}
  all[kind][name] = facts
  await fs.writeFile(FACTS_FILE, JSON.stringify(all, null, 2) + '\n', 'utf8')
}

export class CleanlinessError extends Error {}

/** 断言当前页面符合清场纪律；不合规就抛 CleanlinessError（采集脚本记为 ✗ 并删除产物） */
export async function assertClean(page, must = []) {
  const text = await page.evaluate(() => document.body.innerText)
  const forbidden = [...FORBIDDEN_TEXT]
  if (SUFFIX === '-clean') forbidden.push(BANNER_TEXT)
  const bad = forbidden.filter((f) => text.includes(f))
  const zero = text.match(ZERO_COUNT)
  if (zero) bad.push(`0 计数「${zero[0].trim()}」`)
  const missing = must.filter((m) => !text.includes(m))
  if (bad.length || missing.length) {
    throw new CleanlinessError(`清场自检失败：出现[${bad.join(' / ')}] 缺少[${missing.join(' / ')}]`)
  }
  return text
}

export { writeSeedArchives, SEED_FN }
