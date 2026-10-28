/**
 * 录屏采集：promo/capture/clips/<name>.webm
 *
 * viewport 1920x1080、deviceScaleFactor 1、recordVideo.size 1920x1080；
 * 每条 4–9s，收尾自动静置 >= 1.2s（harness.record 的 tail）。
 *
 * 用法：node promo/scripts/capture/capture-clips.mjs [name ...]
 */
import {
  launch, record, go, settle, exposeModules, scrollMain, startRecording,
  synthDrag, waitForText, waitForLevel, assertClean, collectFacts, saveFacts, CLIPS, SUFFIX,
} from './lib/harness.mjs'
import { prePolishPatch, POLISH_LLM_JSON } from './lib/seed.mjs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const only = process.argv.slice(2)
const pick = (n) => only.length === 0 || only.includes(n)

const DESKTOP = { width: 1920, height: 1080 }
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

async function main() {
  await mkdir(CLIPS, { recursive: true })
  const browser = await launch()

  const run = async (name, opts, fn) => {
    if (!pick(name)) return
    const t0 = Date.now()
    const { must = [], ...recOpts } = opts
    // 录屏收尾帧（即剪辑要用的静置帧）也要过清场自检，并当场记录画面事实
    const wrapped = async (page) => {
      await fn(page)
      await assertClean(page, [...must, ...(process.env.MUST_EXTRA ? [process.env.MUST_EXTRA] : [])])
      await saveFacts('clips', name + SUFFIX, {
        ...(await collectFacts(page)),
        viewport: DESKTOP, deviceScaleFactor: 1,
      })
    }
    try {
      const file = await record(browser, name + SUFFIX, DESKTOP, wrapped, recOpts)
      results.push({ name, path: path.relative(path.join(CLIPS, '..'), file) })
      console.log(`  ✓ ${name}  ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } catch (e) {
      console.error(`  ✗ ${name}:`, e.message)
      results.push({ name, error: e.message })
    }
  }

  // 1. 今天页 → 点「开始录音」→ 进入会中速记，手打两条关键词
  await run('record-start', { must: ['速记', '仅麦克风', '实时字幕'] }, async (page) => {
    await page.waitForTimeout(500)
    await startRecording(page)
    await settle(page, 600)
    const input = page.getByPlaceholder(/q4 预算|再记一条/).first()
    await input.click()
    for (const kw of ['Q4 优先级：转录质量 > 一次成稿', '热词表 周三前进测试']) {
      await input.pressSequentially(kw, { delay: 24 })
      await page.waitForTimeout(140)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(1_000)
    }
  })

  // 2. 实时字幕一条条长出来（真跑 liveCaption 状态机，字幕源见 README 披露）
  await run('live-caption', { sr: true, initScripts: [() => { window.__srPace = 550 }], must: ['实时字幕', 'Q4 的路线优先级'] }, async (page) => {
    await page.waitForTimeout(400)
    await startRecording(page)
    // 8 条字幕在 ~4.6s 内吐完，之后画面不再变化（尾部静置由 record() 保证）
    await page.waitForTimeout(4_900)
    await waitForLevel(page, 0.5)
  })

  // 3. 会议里点「重新整理」→ 笔记从速记骨架变成四段式 + 待办出现
  await run('polish', {
    must: ['一句话结论', '会议待办', '全部确认'],
    llmStub: { json: POLISH_LLM_JSON, delayMs: 1_400 },
    patchSeed: prePolishPatch,
  }, async (page) => {
    await go(page, 'meeting-detail', { id: 'm-q4-plan' })
    await scrollMain(page, 300)
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: /重新整理/ }).first().click()
    await waitForText(page, '一句话结论', { timeout: 20_000 })
    await page.waitForTimeout(500)
    await scrollMain(page, 0)
    await page.waitForTimeout(900)
  })

  // 4. 转录：点时间戳跳播（高亮 + 音频定位）
  await run('transcript-speakers', { must: ['说话人 1', '总时长'] }, async (page) => {
    await go(page, 'meeting-detail', { id: 'm-q4-plan' })
    await page.getByRole('button', { name: '转录', exact: true }).click()
    await page.waitForTimeout(800)
    for (const ts of ['01:22', '04:20', '06:40']) {
      const b = page.getByRole('button', { name: ts, exact: true }).first()
      if (await b.isVisible().catch(() => false)) { await b.click(); await page.waitForTimeout(1_250) }
    }
    await settle(page, 300)
  })

  // 5. OKR 三视图切换：今日焦点 → 本季 OKR → 战略
  await run('okr-views', { must: ['INBOX', '2026-Q4', '让中文会议记录不再需要人肉整理'] }, async (page) => {
    await go(page, 'todos', { mode: 'focus' })
    await page.waitForTimeout(1_200)
    for (const label of ['本季 OKR', '战略']) {
      await page.getByRole('tab', { name: label, exact: true }).first().click()
      await settle(page, 1_400)
    }
    await page.waitForTimeout(400)
  })

  // 6. 把 Inbox 里的一条拖到项目 KR 上（真派发 DragEvent）
  await run('okr-attach', { must: ['INBOX', '整理客户访谈录音清单'] }, async (page) => {
    await go(page, 'todos', { mode: 'strategy' })
    await page.waitForTimeout(1_100)
    await synthDrag(
      page,
      '[data-todo-id="t-inbox-3"] > div[draggable]',
      '[data-todo-id="kr-proj-1"] > div[draggable]',
      0.5,
    )
    await page.waitForTimeout(1_500)
  })

  // 7. 看板拖卡片：待办 → 进行中
  await run('board-drag', { must: ['看板', '进行中', '完成'] }, async (page) => {
    await go(page, 'board')
    await page.waitForTimeout(1_000)
    await synthDrag(
      page,
      '[data-testid="board-col-todo"] article[draggable]',
      '[data-testid="board-col-doing"]',
      0.5,
    )
    await page.waitForTimeout(1_400)
  })

  // 8. 周报：滚到「风险与阻塞 / 下周计划」→ 复制 Markdown → 已复制 ✓
  //    注：不切到「上一周」——上一周没有卡片和会议，产品会如实显示
  //    「本周暂无已完成的卡片」等空状态文案，按契约不能在成片里出现。
  await run('report', { must: ['本周总结', '风险与阻塞', '下周计划'] }, async (page) => {
    await go(page, 'report')
    await page.waitForTimeout(900)
    await page.evaluate(() => {
      const doc = document.querySelector('[data-testid="report-doc"]')
      if (doc) doc.scrollTop = doc.scrollHeight
    })
    await settle(page, 1_100)
    await page.getByRole('button', { name: /复制 Markdown/ }).first().click()
    await settle(page, 1_100)
  })

  // 9. 设置：三选一切换 + 数据去向自检如实变化（本机内置如实禁用，不点）
  await run('settings-ai', { patchSeed: LOCAL_LOOPBACK_SEED, must: ['AI 运行在哪里', '需要 macOS 桌面版', '数据去向', '会议内容全部留在本机'] }, async (page) => {
    await go(page, 'settings')
    await page.waitForTimeout(800)
    await page.getByRole('radio', { name: /云端 API/ }).first().click()
    await settle(page, 1_500)
    await page.getByRole('radio', { name: /自建本地服务/ }).first().click()
    await settle(page, 1_100)
    await scrollMain(page, 150)
    await settle(page, 900)
  })

  // 10. 导出 .zip 全量备份（进度 → 成功文案）
  await run('export-zip', { must: ['已导出', '数据'] }, async (page) => {
    await go(page, 'settings')
    await page.waitForTimeout(700)
    await scrollMain(page, 100_000) // 滚到页尾的数据区
    await page.waitForTimeout(700)
    const btn = page.getByRole('button', { name: /^导出 \.zip$/ }).first()
    await btn.click()
    await waitForText(page, '已导出', { timeout: 60_000 })
    await settle(page, 1_000)
  })

  await browser.close()
}

main().then(() => {
  console.log('\nclips:', results.length, 'ok:', results.filter((r) => !r.error).length)
  const bad = results.filter((r) => r.error)
  if (bad.length) { console.error('failed:', bad); process.exitCode = 1 }
})
