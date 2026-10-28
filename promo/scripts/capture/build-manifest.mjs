/**
 * 生成 promo/capture/MANIFEST.json（分镜契约 §4.1）。
 *
 * 所有 w/h 与 duration_s 一律由 ffprobe **实测**，不做估算；
 * 空状态 / 报错 / 0 计数 / 浏览器提示条 / 置灰项等「画面事实」来自采集当场的 DOM 采样
 * （`capture-*.mjs` 写出的 .capture-facts.json），不是事后手写。
 *
 * 用法：node promo/scripts/capture/build-manifest.mjs
 */
import { execFile } from 'node:child_process'
import { readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const FF = process.env.FFPROBE ?? '/opt/homebrew/bin/ffprobe'
const CAPTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../capture')

async function probe(file, { duration = false } = {}) {
  const { stdout } = await exec(FF, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-show_entries', duration ? 'format=duration' : 'stream=codec_name',
    '-of', 'json', file])
  const j = JSON.parse(stdout)
  const s = j.streams?.[0] ?? {}
  return {
    w: Number(s.width), h: Number(s.height), codec: s.codec_name,
    duration_s: duration ? Number(Number(j.format?.duration ?? 0).toFixed(3)) : undefined,
  }
}

/** [name, scene, content] */
const STILLS = [
  ['today', 'SH-01', '今天页：今日 7 条（逾期 / 今天 / Inbox / AI 待审 4 条）+ 接下来的会议 2 场'],
  ['today-cmdk', null, '⌘K 命令面板（动作 + 跳转；录音快捷键如实显示 ⌘⇧R）。分镜未直接引用，作为备用素材'],
  ['live-meeting', 'SH-03', '会中：速记 7 条带时间锚点 + 实时字幕 8 条 + 相关资料 4 张固定卡（保留浏览器能力提示条）'],
  ['live-meeting-clean', 'SH-03', '同上，隐藏浏览器能力提示条的干净版'],
  ['meeting-note', 'SH-04', '会议详情 · 笔记：一句话结论 / 讨论要点 / 决定 / 行动项'],
  ['meeting-todo-confirm', 'SH-04', '会议详情 · 会议待办 4 条：原文引用 + 建议 KR + 全部确认'],
  ['meeting-transcript', 'SH-05', '转录 Tab：说话人 1/2/3 + 时间戳跳播 + 录音回放（总时长 18:24）'],
  ['okr-focus', 'SH-06', '任务 · 今日焦点（Inbox + 本季度 + 本周活跃 KR）'],
  ['okr-quarter', 'SH-06', '任务 · 本季 OKR（2026-Q4）'],
  ['okr-strategy', 'SH-06', '任务 · 战略树（战略 O → KR → 季度 O → 项目 KR → Task，加权进度条）'],
  ['board', 'SH-07', '看板四列：待办 5 / 进行中 2 / 评审 2 / 完成 8，四列都有卡'],
  ['report', 'SH-07', '周报（10月12日–10月18日）：本周总结 / 关键进展 / 会议 / 风险与阻塞 / 下周计划，无任何 fallback 空状态'],
  ['settings-ai', 'SH-08', '设置：AI 运行在哪里三选一（「本机内置」如实置灰并标注需要 macOS 桌面版）+ 数据去向自检'],
  ['data-flow', 'SH-08', '设置 · 数据去向卡：✓ 会议内容全部留在本机（两条链路都判为本机）'],
  ['mobile-today', 'SH-09', '移动端 390×844 今天页'],
  ['ipad-board', 'SH-09', 'iPad 横版 1366×1024 看板（四列同屏）'],
  ['ipad-portrait', 'SH-09', 'iPad 竖版 768×1024 任务 · 今日焦点（3:4，正合 tablet-frame 内屏 612×816）'],
]

const CLIPS = [
  ['record-start', 'SH-03', '今天页 → 点「● 开始录音」→ 进入会中速记，手打两条关键词'],
  ['live-caption', 'SH-03', '会中实时字幕一条条长出来（速记 + 电平条同屏）'],
  ['polish', 'SH-04', '会议详情 → 点「重新整理」→ 笔记从速记骨架变四段式，会议待办出现（含原文引用与建议 KR）'],
  ['transcript-speakers', 'SH-05', '转录 Tab：说话人 1/2/3，点时间戳跳播并高亮该段'],
  ['okr-views', 'SH-06', '任务页视角切换：今日焦点 → 本季 OKR → 战略树'],
  ['okr-attach', 'SH-06', '战略视图：把 Inbox 里的任务拖到项目 KR 上归位'],
  ['board-drag', 'SH-07', '看板：卡片从「待办」拖到「进行中」'],
  ['report', 'SH-07', '周报：滚到风险与阻塞 / 下周计划 → 复制 Markdown → 已复制 ✓'],
  ['settings-ai', 'SH-08', '设置：三选一切换（云端 API → 自建本地服务；「本机内置」如实置灰不可点）→ 数据去向自检如实变化'],
  ['export-zip', 'SH-09', '设置 · 数据：导出 .zip 全量备份成功（进度文案 → 已导出 …KB · N 段音频）'],
  ['record-start-clean', 'SH-03', '干净版：隐藏浏览器能力提示条的 record-start'],
  ['live-caption-clean', 'SH-03', '干净版：隐藏浏览器能力提示条的 live-caption'],
]

const CLEAN_NOTE = '本条目取自 *-clean 素材（HIDE_CAPTURE_BANNER=1）'
const DISABLED_WHY = {
  '本机内置': '产品如实置灰：浏览器版没有内置模型推理能力（web/src/lib/builtinModels.ts:15），旁注「需要 macOS 桌面版」',
  '本周': '当前就在本周，按钮按产品逻辑禁用（周报页）',
  '保存修改': '设置页无未保存改动时的常态置灰',
  '↻ 立即同步': '日历未配置 ICS 地址时的常态置灰',
}

const emptyState = (f) => (f?.empty_state_hits?.length ?? 0) > 0
const disabled = (f) => (f?.disabled_items ?? []).map((label) => ({
  label, reason: DISABLED_WHY[label] ?? '产品常态置灰（非缺陷）',
}))

async function main() {
  let facts = { stills: {}, clips: {} }
  try { facts = JSON.parse(await readFile(path.join(CAPTURE, '.capture-facts.json'), 'utf8')) } catch { /* 首次 */ }

  const stills = []
  for (const [name, scene, content] of STILLS) {
    const rel = `stills/${name}.png`
    await stat(path.join(CAPTURE, rel))
    const { w, h } = await probe(path.join(CAPTURE, rel))
    const f = facts.stills?.[name] ?? {}
    stills.push({
      name, file: rel, path: rel, scene, w, h,
      size: f.size ?? `${w}x${h}`,
      viewport: f.viewport ? `${f.viewport.width}x${f.viewport.height}` : null,
      deviceScaleFactor: f.deviceScaleFactor ?? null,
      route: f.route ?? null,
      has_empty_state: emptyState(f),
      has_browser_banner: Boolean(f.browser_banner),
      zero_count_hits: f.zero_count_hits ?? [],
      error_hits: f.error_hits ?? [],
      onboarding_hits: f.onboarding_hits ?? [],
      disabled_items: disabled(f),
      content: name.endsWith('-clean') ? `${content}（${CLEAN_NOTE}）` : content,
    })
  }

  const clips = []
  for (const [name, scene, content] of CLIPS) {
    const rel = `clips/${name}.webm`
    await stat(path.join(CAPTURE, rel))
    const m = await probe(path.join(CAPTURE, rel), { duration: true })
    const f = facts.clips?.[name] ?? {}
    clips.push({
      name, file: rel, path: rel, scene,
      duration_s: m.duration_s, w: m.w, h: m.h,
      route: f.route ?? null,
      has_empty_state: emptyState(f),
      has_browser_banner: Boolean(f.browser_banner),
      zero_count_hits: f.zero_count_hits ?? [],
      error_hits: f.error_hits ?? [],
      onboarding_hits: f.onboarding_hits ?? [],
      disabled_items: disabled(f),
      content: name.endsWith('-clean') ? `${content}（${CLEAN_NOTE}）` : content,
    })
  }

  const problems = []
  for (const s of stills) {
    const want = s.name === 'mobile-today' ? [1170, 2532]
      : s.name === 'ipad-board' ? [2732, 2048]
        : s.name === 'ipad-portrait' ? [1536, 2048] : [3840, 2160]
    if (s.w !== want[0] || s.h !== want[1]) problems.push(`${s.name} 尺寸 ${s.w}x${s.h} ≠ ${want[0]}x${want[1]}`)
    if (s.has_empty_state || s.error_hits.length || s.onboarding_hits.length || s.zero_count_hits.length) {
      problems.push(`${s.name} 画面含空状态/报错/引导浮层/0 计数`)
    }
    if (!s.route) problems.push(`${s.name} 缺少采集当场的 route 事实（未跑过采集？）`)
  }
  for (const c of clips) {
    if (c.w !== 1920 || c.h !== 1080) problems.push(`${c.name} 分辨率 ${c.w}x${c.h} ≠ 1920x1080`)
    if (c.duration_s < 4 || c.duration_s > 9) problems.push(`${c.name} 时长 ${c.duration_s}s 不在 4–9s`)
    if (c.has_empty_state || c.error_hits.length || c.onboarding_hits.length || c.zero_count_hits.length) {
      problems.push(`${c.name} 画面含空状态/报错/引导浮层/0 计数`)
    }
    if (c.name.endsWith('-clean') && c.has_browser_banner) problems.push(`${c.name} 干净版仍含浏览器提示条`)
  }

  const out = {
    generated_at: new Date().toISOString(),
    stills,
    clips,
    contract: {
      still_desktop: 'viewport 1920x1080 · deviceScaleFactor 2 → 3840x2160',
      still_mobile: 'viewport 390x844 · deviceScaleFactor 3 → 1170x2532',
      still_ipad_landscape: 'viewport 1366x1024 · deviceScaleFactor 2 → 2732x2048',
      still_ipad_portrait: 'viewport 768x1024 · deviceScaleFactor 2 → 1536x2048（3:4，合 tablet-frame 内屏 612x816）',
      clip: 'viewport 1920x1080 · deviceScaleFactor 1 · recordVideo.size 1920x1080 · 每条 4–9s · 结尾静置 ≥1.2s',
      measured_by: 'ffprobe 实测（本文件所有 w/h/duration_s）+ verify-frames.py 像素自检',
    },
    disclosure: [
      '演示数据由 promo/scripts/capture/lib/seed.mjs 直接写入 IndexedDB `shibei`（字段照 web/src/types.ts），完整存档见 seed/*.json；不是真实用户数据，也没有真实录音内容（audioChunks 里是页面内合成的静音 WAV，用于让「录音回放」不是空状态）。',
      '实时字幕的中文文本**不是真实识别结果**：headless Chromium 没有可用的中文 ASR 后端，采集环境注入 window.SpeechRecognition 桩喂脚本化 onresult 事件，但驱动的是产品真实代码路径 web/src/lib/liveCaption.ts（useCaption store / kv live_caption_<id> / 面板累积滚动 / on·blocked·unsupported 状态机）。',
      '假麦克风不是真人说话：--use-file-for-fake-audio-capture 指向 promo/scripts/capture/lib/fake-mic.mjs 现场合成的类人声 WAV，使电平条全程可见（Chromium 自带假设备只在开头约 3s 有声，会让电平条趴平）。',
      'polish 片段的 LLM 调用换成本地确定性响应（seed/polish-llm-response.json）：本机无云端 Key，跑的是真实 pipeline/summarize.ts（含旧 pending_review 待办清理与重建、标题回写、原文引用定位）。',
      '录音时产品会如实显示「浏览器中只能录制麦克风；系统声音需 NotesToGO 桌面版…」。默认素材保留它；*-clean 素材隐藏它，供 SH-03 成片选用（桌面版本身能录系统声音，成片用干净版不构成虚假宣称）。',
      'DB 已置 onboarding_done_v1=true，并在采集时按掉 Onboarding 首帧渲染竞态（等价于点面板上的 ✕），保证画面里不出现引导浮层。',
      '本机 MiniMax 视觉复核（understand_image）本轮配额用尽、Gemini/Codex 通道亦不可用，所以逐帧目视改由 clean 自检（DOM 断言）+ verify-frames.py（像素断言）+ Lead 抽检承担；未做任何贴字或改文案。',
    ],
    verify: { problems, ok: problems.length === 0 },
  }

  await writeFile(path.join(CAPTURE, 'MANIFEST.json'), JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log(`MANIFEST.json: ${stills.length} stills, ${clips.length} clips`)
  const banner = [...stills, ...clips].filter((x) => x.has_browser_banner).map((x) => x.name)
  const dis = [...stills, ...clips].filter((x) => x.disabled_items.length).map((x) => `${x.name}:[${x.disabled_items.map((d) => d.label).join(',')}]`)
  console.log('含浏览器能力提示条（已如实标注）:', banner.join(', ') || '（无）')
  console.log('含置灰项（已如实标注）:', dis.join(' ') || '（无）')
  if (problems.length) { console.error('自检未通过：'); problems.forEach((p) => console.error(' - ' + p)); process.exitCode = 1 }
  else console.log('尺寸/时长/清场自检：全部通过')
}

main()
