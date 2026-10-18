/**
 * 静帧采集：promo/capture/stills/<name>.png
 *
 * 桌面 1920x1080 @dsf2 = 3840x2160；移动 390x844 @dsf3 = 1170x2532；
 * iPad 1366x1024 @dsf2 = 2732x2048（横屏，看板四列全可见）。
 *
 * 用法：node promo/scripts/capture/capture-stills.mjs [name ...]
 */
import {
  launch, newPage, go, shot, settle, exposeModules, scrollMain, waitForLevel,
  startRecording, enrichLiveMeeting, STILLS, DESKTOP, MOBILE, IPAD, IPAD_PORTRAIT,
  SUFFIX, assertClean, collectFacts, saveFacts, writeSeedArchives, SEED_DIR,
} from './lib/harness.mjs'
import { buildSeed } from './lib/seed.mjs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const only = process.argv.slice(2)
const pick = (name) => only.length === 0 || only.includes(name)

// ── 会中真录音：速记按真实 elapsed 节奏写进去 ──────────────────────────────
const LIVE_SCRIBBLES = [
  { t_ms: 900, text: 'Q4 优先级：转录质量 > 一次成稿 > 周报' },
  { t_ms: 3_400, text: '问题：拾贝 → 十倍，纪要跟着错' },
  { t_ms: 6_600, text: '热词表 周三前进测试' },
  { t_ms: 10_000, text: '散会后一次调用：标题 + 纪要 + 行动项' },
  { t_ms: 13_800, text: '行动项必须带原文引用' },
  { t_ms: 17_600, text: '周报 = 可复制 Markdown，不做 PDF' },
  { t_ms: 21_400, text: '数据去向：局域网不能算「本机」' },
]
const LIVE_PINNED = {
  source_entry_id: 'ke-2',
  title: '术语表：拾贝产品词条',
  snippet: '拾贝、一次成稿、嵌套 OKR、重新整理、数据去向。',
  path: '/Users/fangchen/Documents/拾贝知识库/术语表-拾贝产品词条.md',
}

/**
 * SH-08 的诚实取景（按 lead 2026-10-18 约束）：
 * 浏览器版**没有**内置模型推理能力（web/src/lib/builtinModels.ts:15，
 * builtinAvailable()=false → 三选一里「本机内置」如实禁用并标注「需要 macOS 桌面版」）。
 * 所以不启用 DEV mock 伪造下载进度，也不隐藏任何「需要桌面版」提示；
 * 「数据去向」自检卡用真实的「自建本地服务（回环地址）」配置呈现
 * —— 此时两条链路都判为本机，文案是产品原文「✓ 会议内容全部留在本机」。
 */
const LOCAL_LOOPBACK_SEED = (seed) => {
  seed.kv.settings = {
    ...seed.kv.settings,
    ai_mode: 'local',
    asr_mode: 'local',
    local_llm_base_url: 'http://127.0.0.1:11434/v1',
    local_llm_model: 'llama3.2',
    local_asr_base_url: 'http://127.0.0.1:8080/v1',
    local_asr_model: 'whisper-1',
  }
}

const results = []

async function run() {
  await mkdir(STILLS, { recursive: true })
  await writeSeedArchives(SEED_DIR, buildSeed(new Date()))
  const browser = await launch()

  const capture = async (name, cfg, action) => {
    if (!pick(name)) return
    const t0 = Date.now()
    const { context, page } = await newPage(browser, cfg)
    try {
      await action(page)
      await assertClean(page, cfg.must ?? [])
      const facts = await collectFacts(page)
      const file = await shot(page, name + SUFFIX, { wait: cfg.settleMs ?? 240 })
      await saveFacts('stills', name + SUFFIX, {
        ...facts,
        viewport: cfg.viewport, deviceScaleFactor: cfg.dsf,
        size: `${cfg.viewport.width * cfg.dsf}x${cfg.viewport.height * cfg.dsf}`,
      })
      results.push({ name, path: path.relative(path.dirname(STILLS), file), w: cfg.viewport.width * cfg.dsf, h: cfg.viewport.height * cfg.dsf })
      console.log(`  ✓ ${name}  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } catch (e) {
      console.error(`  ✗ ${name}:`, e.message)
      results.push({ name, error: e.message })
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  const D = { viewport: DESKTOP, dsf: 2 }

  // 1. 今天页
  await capture('today', { ...D, must: ['今日', '接下来的会议', 'Inbox', '逾期'] }, async (page) => {
    await go(page, 'today')
  })

  // 2. 今天页 + ⌘K 命令面板
  await capture('today-cmdk', { ...D, must: ['开始录音', '⌘⇧R', '设置'] }, async (page) => {
    await go(page, 'today')
    await page.getByRole('button', { name: /搜索 \/ 命令/ }).first().click()
    await page.getByPlaceholder(/输入命令|搜索/).first().waitFor({ timeout: 5000 }).catch(() => undefined)
    await settle(page, 420)
  })

  // 3. 会中（真录音 + 真速记 + 实时字幕）
  await capture('live-meeting', {
    ...D,
    must: ['实时字幕', '速记', '相关资料', '仅麦克风', '条'],
    sr: true,
    initScripts: [() => { window.__srPace = 2900 }],
  }, async (page) => {
    const id = await startRecording(page)
    await enrichLiveMeeting(page, id, { title: 'Q4 产品路线讨论', scribbles: LIVE_SCRIBBLES, pinned: LIVE_PINNED })
    // 录到约 24s：速记全部落位、字幕累积到 7~8 条、REC 计时与速记时间戳自洽
    await page.waitForTimeout(23_000)
    await page.evaluate(() => document.activeElement?.blur?.())
    await waitForLevel(page, 0.55)
  })

  // 4. 会议详情 · 笔记（一句话结论 / 讨论要点 / 决定 / 行动项）
  await capture('meeting-note', { ...D, must: ['一句话结论', '讨论要点', '决定', '行动项'] }, async (page) => {
    await go(page, 'meeting-detail', { id: 'm-q4-plan' })
    await scrollMain(page, 372)
  })

  // 5. 会议待办确认条带（原文引用 + 建议 KR + 全部确认）
  await capture('meeting-todo-confirm', { ...D, must: ['会议待办', '全部确认', '项目 KR', '转录'] }, async (page) => {
    await go(page, 'meeting-detail', { id: 'm-q4-plan' })
  })

  // 6. 转录（说话人 1/2/3 + 时间戳 + 录音回放）
  await capture('meeting-transcript', { ...D, must: ['说话人 1', '说话人 2', '总时长', '片'] }, async (page) => {
    await go(page, 'meeting-detail', { id: 'm-q4-plan' })
    await page.getByRole('button', { name: '转录', exact: true }).click()
    await settle(page, 800)
    await scrollMain(page, 240)
  })

  // 7-9. OKR 三视图
  for (const [name, mode] of [['okr-focus', 'focus'], ['okr-quarter', 'quarter'], ['okr-strategy', 'strategy']]) {
    await capture(name, { ...D, must: mode === 'quarter' ? ['2026-Q4', 'INBOX']
        : mode === 'strategy' ? ['INBOX', '让中文会议记录不再需要人肉整理']
        : ['INBOX', '重新整理补齐原文引用与模板切换'] }, async (page) => {
      await go(page, 'todos', { mode })
      await settle(page, 300)
    })
  }

  // 10. 看板（四列都有卡）
  await capture('board', { ...D, must: ['看板', '待办', '进行中', '评审', '完成'] }, async (page) => {
    await go(page, 'board')
    await settle(page, 400)
  })

  // 11. 周报
  await capture('report', { ...D, must: ['本周总结', '关键进展', '风险与阻塞', '下周计划', '复制 Markdown'] }, async (page) => {
    await go(page, 'report')
    await settle(page, 300)
  })

  // 12-13. 设置 · AI 运行在哪里（三选一，本机内置如实禁用）/ 数据去向自检
  const settingsCfg = { ...D, patchSeed: LOCAL_LOOPBACK_SEED }
  await capture('settings-ai', { ...settingsCfg, must: ['AI 运行在哪里', '本机内置', '需要 macOS 桌面版', '数据去向', '会议内容全部留在本机'] }, async (page) => {
    await go(page, 'settings')
    await settle(page, 320)
  })
  await capture('data-flow', { ...settingsCfg, must: ['数据去向', '会议内容全部留在本机', '本机'] }, async (page) => {
    await go(page, 'settings')
    await scrollMain(page, 150)
  })

  // 14. 移动端今天页
  await capture('mobile-today', { viewport: MOBILE, dsf: 3, must: ['今日', '全部任务'] }, async (page) => {
    await go(page, 'today')
    await settle(page, 300)
  })

  // 15. iPad 看板（横版 1366x1024@2 = 2732x2048）
  await capture('ipad-board', { viewport: IPAD, dsf: 2, settleMs: 420, must: ['看板', '待办', '完成'] }, async (page) => {
    await go(page, 'board')
    await settle(page, 500)
  })

  // 16. iPad 竖版（768x1024@2 = 1536x2048，比例 3:4，正合品牌 tablet-frame 内屏 612x816）
  //     看板四列 `min-w-[240px]`，768px 视口下侧栏占 208px → 只看得到约 2 列且要横向滚，
  //     所以竖版拍「任务 · 今日焦点」，内容完整不塌。
  await capture('ipad-portrait', { viewport: IPAD_PORTRAIT, dsf: 2, settleMs: 420, must: ['今日焦点', 'INBOX'] }, async (page) => {
    await go(page, 'todos', { mode: 'focus' })
    await settle(page, 400)
  })

  await browser.close()
}

run().then(() => {
  console.log('\nstills:', results.length, 'ok:', results.filter((r) => !r.error).length)
  const bad = results.filter((r) => r.error)
  if (bad.length) { console.error('failed:', bad); process.exitCode = 1 }
})
