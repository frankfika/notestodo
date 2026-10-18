/**
 * 富数据种子（promo 宣传片素材采集专用）
 *
 * 字段严格照 web/src/types.ts；时间全部相对「运行时刻」推导，
 * 保证：本周完成的卡片落在本周、逾期/下周计划的截止日不会漂移。
 *
 * 产出 JSON 存档到 promo/capture/seed/*.json（见 writeSeedArchives）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

// ── 时间工具 ────────────────────────────────────────────────────────────────
const p2 = (n) => String(n).padStart(2, '0')
export const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`

/** 本地时间 -> ISO（应用全程用 new Date(iso) + 本地 getter，保持一致） */
const at = (d, h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).toISOString()
const day = (base, n) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + n, base.getHours(), base.getMinutes(), 0, 0)

/** 本周一 00:00（周一为一周之始，与 ReportPage.weekRange 一致） */
export function weekMonday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7))
}

/** 把 (now - k 天) 夹进本周内，避免周一运行时落到上一周 */
function withinThisWeek(now, k) {
  const mon = weekMonday(now)
  const cand = day(now, -k)
  return cand.getTime() < mon.getTime() ? mon : cand
}

const META = (ts) => ({ created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 })

// ── 会议 + 转录 + 纪要 + 速记 ────────────────────────────────────────────────

const NOTE_Q4 = `## 一句话结论

Q4 只做两件事：把中文转录质量提到可交付，再把「散会后一次成稿」做到日常可用。周报改为自动生成可复制的 Markdown，数据去向按实际情况如实标注。

## 讨论要点

- **中文转录质量是前置条件。** 上周客户访谈里「拾贝」被识别成「十倍」，纪要跟着一起错，用户对纪要的信任直接受损。
- **热词表是投入产出最高的一步。** 产品名、人名、专有名词进 hotwords，周三前接进转录请求，先拿 50 场历史录音跑回归。
- **一次成稿是这季度最重要的一件事。** 散会后一次调用同时产出标题、完整纪要与行动项，不再让用户点第二下。
- **行动项必须带原文引用。** 用户看到「谁说过」才敢确认；实在定位不到出处的也要保留，只标注不确定。
- **说话人区分补齐后半段。** 3D-Speaker 中文声纹（两个模型共 30MB）标出说话人 1、2、3，改名后回写转录。
- **周报不用手写。** 本周完成的卡片、开过的会、KR 进度都在库里，拼成 Markdown 草稿并补上风险与下周计划，复制即可贴飞书。
- **数据去向不能含糊。** 局域网地址此前被误判为「本机」，需如实标成离开本机；内置模型下载补断点续传与下载源自动切换。

## 决定

1. Q4 优先级：中文转录质量 → 一次成稿 → 周报自动化 → 数据去向自检。
2. 周报只交付可复制的 Markdown 草稿，不做 PDF 导出。
3. 行动项一律带原文引用；定位不到出处的保留并标注，不静默丢弃。
4. 数据去向自检对「局域网地址」不得显示为本机。

## 行动项

- 热词表接入转录请求，跑 50 场历史录音回归 —— 王五，本周三前
- 重新整理管线补齐行动项的原文引用与模板切换 —— 李四
- 周报草稿补齐风险与下周计划段 —— 李四
- 数据去向自检如实标出局域网地址 —— 王五
- 内置模型下载补断点续传与下载源自动切换 —— 李四
`

/** 会中只记关键词的「整理前」笔记：用于 polish 录屏展示「重新整理」带来的变化 */
const NOTE_Q4_PRE = `## 会中速记

- [00:42] Q4 优先级：转录质量 > 一次成稿 > 周报
- [01:35] 问题：拾贝 → 十倍，纪要跟着错
- [02:10] 热词表：周三前进测试
- [05:05] 散会后一次调用，别再点第二下
- [06:00] 行动项必须带原文引用
- [08:40] 周报 = 可复制 Markdown，不做 PDF
- [10:00] 数据去向：局域网不能算「本机」
`

/**
 * 18 分钟路线评审的转录。说话人保持「说话人 N」原始标签
 * （分镜 SH-05 的画面就是「说话人 1 / 说话人 2 + 时间戳」）；
 * 真实姓名出现在待办 assignee / 1on1 会议标题里。
 */
const TRANSCRIPT_Q4 = [
  [15_000, 48_000, '说话人 1', '今天主要定 Q4 的路线优先级，先过一遍手上的候选，然后决定砍掉哪些。'],
  [48_000, 82_000, '说话人 2', '我这边最担心的是中文转录质量。上周那场客户访谈，转录把「拾贝」识别成了「十倍」，纪要跟着一起错。'],
  [82_000, 120_000, '说话人 3', '热词表已经在做了，把产品名、人名、专有名词塞进去，转录请求里带上 hotwords，能救回来一大半。'],
  [120_000, 158_000, '说话人 1', '那转录这条就按「先热词、再说话人区分」排。热词表本周能进测试吗？'],
  [158_000, 176_000, '说话人 3', '能，周三之前我把它接进转录请求，先拿 50 场历史录音跑回归。'],
  [221_000, 265_000, '说话人 2', '我再提一个更前置的：散会后出纪要这一步，现在还得人工点「整理笔记」，而且模板给的结构不稳定。'],
  [265_000, 310_000, '说话人 1', '一次成稿是这季度最重要的一件事。散会后一次调用就把标题、完整纪要和行动项一起给出来，不要让用户点第二下。'],
  [310_000, 352_000, '说话人 2', '那重新整理这条管线要补三块：行动项的原文引用、模板切换，还有标题的生成。'],
  [352_000, 376_000, '说话人 1', '行动项必须带原文引用，用户看到「张三说过」才敢确认。实在找不到出处的也别丢，标一下就行。'],
  [376_000, 422_000, '说话人 3', '说话人区分我接了 3D-Speaker 的中文声纹，两个模型一共 30MB，能标出说话人 1、2、3；改名之后回写转录。'],
  [422_000, 456_000, '说话人 1', '好。周报这边呢？上周大家反馈还是得手写。'],
  [500_000, 545_000, '说话人 2', '周报的数据其实都在库里：本周完成的卡片、开过的会、还有 KR 进度。我把它拼成 Markdown 草稿，补上风险和下周计划，复制就能贴飞书。'],
  [545_000, 590_000, '说话人 1', '那就定：周报草稿直接给可复制的 Markdown，不做 PDF 导出。'],
  [590_000, 626_000, '说话人 3', '数据去向那块我想补一句。局域网地址现在会被当成「本机」，这是错的，得如实标成离开本机。'],
  [700_000, 734_000, '说话人 1', '对，合规上不能含糊。内置模型下载也加上断点续传，别让用户重下一遍。'],
  [734_000, 768_000, '说话人 2', '断点续传我这周一起做了，顺便把下载源自动切换补上。'],
  [870_000, 906_000, '说话人 1', '还有一个：今天页现在只放 Inbox 和今天到期的，太多了反而看不清重点。'],
  [1010_000, 1050_000, '说话人 1', '今天就到这儿。行动项我让纪要自动提，大家明天在任务页确认一下。'],
]

const NOTE_ONBOARDING = `## 一句话结论

新用户引导从「三步配置」改成「一句话说清价值 + 一键跑通第一次录音」，把首次到达会中页的步数从 5 步压到 2 步。

## 讨论要点

- 现在首次打开要先选 AI 运行在哪里，用户还不知道产品能干什么就被要求做技术决策，流失集中在这一步。
- 引导面板改成右下角气泡，不拦截主界面；「开始录音」始终可点。
- 第一次录音结束后自动整理出纪要，比任何文案都有说服力。

## 决定

1. 引导不拦截主 UI，只做右下角气泡 + 三步以内。
2. 首次录音的默认模板用「标准会议纪要」。

## 行动项

- 引导气泡文案重写，去掉技术名词 —— 李四
- 首次录音结束后的空状态换成一次成稿的示例 —— 王五
`

const NOTE_1ON1 = `## 一句话结论

张三本季度从「什么都跟」收敛到「只负责一次成稿这条线」，其余交给李四与王五。

## 讨论要点

- 手上的活太散，三件事都没做完；需要明确一件事做到能交付。
- 一次成稿是目前离用户最近、也最能说明产品价值的一条线。

## 决定

1. 张三 Q4 只对「一次成稿」负责，每周五同步进度。
2. 会议模板的维护交给王五。

## 行动项

- 每周五给一次成稿的进度快照 —— 张三
- 接手会议模板维护 —— 王五
`

const NOTE_INFRA = `## 一句话结论

上周转录服务两次超时是单请求体过大导致，改为按 5 分钟分片上传后不再复现。

## 讨论要点

- 45 分钟以上的会议，一次性上传音频会被网关拦掉。
- 分片上传 + 失败重试后，50 场回归全部成功。
- 分钟级重试要保留幂等键，避免重复计费。

## 决定

1. 转录一律走分片上传，单片不超过 5 分钟。
2. 重试必须带幂等键。

## 行动项

- 把 5 分钟分片接进转录管线 —— 李四
- 补幂等键的回归用例 —— 王五
`

const NOTE_MEMO = `## 会议速记法：只记关键词

会中不要试图把话记全 —— 记下来的应该是「定位用的锚点」：

- 一个数字（预算、日期、指标）
- 一个名字（谁负责）
- 一个有争议的结论

散会后靠转录把锚点扩写回完整表达。记全了反而会漏掉讨论本身。
`

/** 一次成稿（重新整理）后 LLM 会返回的结构化结果 —— polish 录屏里用于 fetch 拦截 */
export const POLISH_LLM_JSON = {
  title: 'Q4 产品路线评审',
  summary_md: NOTE_Q4,
  decisions: [
    'Q4 优先级：中文转录质量 → 一次成稿 → 周报自动化 → 数据去向自检。',
    '周报只交付可复制的 Markdown 草稿，不做 PDF 导出。',
    '行动项一律带原文引用；定位不到出处的保留并标注，不静默丢弃。',
  ],
  todos: [
    {
      title: '热词表接入转录请求并跑 50 场回归',
      assignee_hint: '王五',
      due_hint: '本周三',
      evidence_quote: '能，周三之前我把它接进转录请求，先拿 50 场历史录音跑回归。',
      evidence_time: '02:38',
    },
    {
      title: '重新整理管线补齐行动项的原文引用',
      assignee_hint: '李四',
      due_hint: '',
      evidence_quote: '那重新整理这条管线要补三块：行动项的原文引用、模板切换，还有标题的生成。',
      evidence_time: '05:10',
    },
    {
      title: '周报草稿补齐风险与下周计划段',
      assignee_hint: '李四',
      due_hint: '',
      evidence_quote: '周报的数据其实都在库里：本周完成的卡片、开过的会、还有 KR 进度。我把它拼成 Markdown 草稿，补上风险和下周计划，复制就能贴飞书。',
      evidence_time: '08:20',
    },
    {
      title: '数据去向自检如实标出局域网地址',
      assignee_hint: '王五',
      due_hint: '',
      evidence_quote: '数据去向那块我想补一句。局域网地址现在会被当成「本机」，这是错的，得如实标成离开本机。',
      evidence_time: '09:50',
    },
  ],
}

/** 会中速记（t_ms 与 18 分钟录音时间轴对齐） */
const SCRIBBLES_Q4 = [
  [12_000, 'Q4 优先级：转录质量 > 一次成稿 > 周报'],
  [95_000, '问题：拾贝 → 十倍，纪要跟着错'],
  [130_000, '热词表 周三前进测试'],
  [300_000, '散会后一次调用：标题 + 纪要 + 行动项'],
  [360_000, '行动项必须带原文引用'],
  [520_000, '周报 = 可复制 Markdown，不做 PDF'],
  [600_000, '数据去向：局域网不能算「本机」'],
]

export const MEETING_Q4 = 'm-q4-plan'
export const MEETING_Q4_NOTE = 'n-q4-plan'

/**
 * 构建完整种子。返回值可直接 JSON 序列化（音频 blob 在页面内按 audio_seconds 生成）。
 */
export function buildSeed(now = new Date()) {
  const ts = now.toISOString()
  const todayStr = ymd(now)
  const mon = weekMonday(now)
  const nextMon = day(mon, 7)
  const M = META(ts)

  // 会议时间：夹进本周内（周报「本周会议」非空），且都早于 now
  const mDates = {
    q4: withinThisWeek(now, 1),
    onboarding: withinThisWeek(now, 3),
    '1on1': withinThisWeek(now, 5),
    infra: withinThisWeek(now, 8),
  }

  // ── 会议 ──────────────────────────────────────────────────────────────────
  const mkMeeting = (id, title, status, start, durationMs, noteId, extra = {}) => ({
    id, title, source: 'manual', status,
    started_at: at(start, 14, 0), ended_at: at(start, 14 + Math.floor(durationMs / 3600_000), 12),
    audio: {
      format: 'audio/webm', codec: 'opus', duration_ms: durationMs,
      chunk_count: Math.max(1, Math.round(durationMs / 300_000)), size_bytes: Math.round(durationMs * 4.6), gaps: [],
    },
    note_id: noteId, ...M, ...extra,
  })

  const meetings = [
    // 主线会议（SH-04 / SH-05 的那一场）
    mkMeeting(MEETING_Q4, 'Q4 产品路线评审', 'summarized', mDates.q4, 1_104_000, MEETING_Q4_NOTE),
    mkMeeting('m-onboarding', '新用户引导改版评审', 'summarized', mDates.onboarding, 960_000, 'n-onboarding'),
    mkMeeting('m-1on1', '1on1 · 张三', 'summarized', mDates['1on1'], 720_000, 'n-1on1'),
    mkMeeting('m-infra', '转录服务稳定性复盘', 'summarized', mDates.infra, 1_320_000, 'n-infra'),
    // 「接下来的会议」条目。
    // 注：TodayPage 用 fmtDateTime(x).slice(6) 取时间列，而 fmtDate 对「今天/昨天/明天」
    // 返回 2 字相对词 → slice(6) 会截出分钟数（如「30」）或空串。只有 ≥2 天前的 ymd
    // 形式（「10月20日 10:00」）才切得出正确时间。故这里放在 2 / 4 天后，避免成片里
    // 出现被截断的时间列。该截断是产品既有渲染问题，已同步给 lead。
    {
      ...mkMeeting('m-upcoming-1', 'Q4 OKR 对齐会', 'summarized', day(now, 2), 0, 'n-upcoming-1'),
      started_at: at(day(now, 2), 10, 0),
      ended_at: undefined,
      audio: { format: 'audio/webm', codec: 'opus', duration_ms: 0, chunk_count: 0, size_bytes: 0, gaps: [] },
    },
    {
      ...mkMeeting('m-upcoming-2', '设计走查 · 看板与周报', 'summarized', day(now, 4), 0, 'n-upcoming-2'),
      started_at: at(day(now, 4), 14, 30),
      ended_at: undefined,
      audio: { format: 'audio/webm', codec: 'opus', duration_ms: 0, chunk_count: 0, size_bytes: 0, gaps: [] },
    },
  ]

  // 每场会议实际写入的静音 WAV 时长（秒）= 会议时长，保证回放条与「总时长」一致
  const audioSeconds = Object.fromEntries(meetings.map((m) => [m.id, m.audio.duration_ms / 1000]))

  // ── 笔记 ──────────────────────────────────────────────────────────────────
  const notes = [
    { id: MEETING_Q4_NOTE, title: 'Q4 产品路线评审', body_md: NOTE_Q4, meeting_id: MEETING_Q4, todo_ids: [], pinned: true, ...M },
    { id: 'n-onboarding', title: '新用户引导改版评审', body_md: NOTE_ONBOARDING, meeting_id: 'm-onboarding', todo_ids: [], pinned: false, ...M },
    { id: 'n-1on1', title: '1on1 · 张三', body_md: NOTE_1ON1, meeting_id: 'm-1on1', todo_ids: [], pinned: false, ...M },
    { id: 'n-infra', title: '转录服务稳定性复盘', body_md: NOTE_INFRA, meeting_id: 'm-infra', todo_ids: [], pinned: false, ...M },
    { id: 'n-memo', title: '会议速记法：只记关键词', body_md: NOTE_MEMO, todo_ids: [], pinned: true, ...M },
    { id: 'n-upcoming-1', title: 'Q4 OKR 对齐会', body_md: '', meeting_id: 'm-upcoming-1', todo_ids: [], pinned: false, ...M },
    { id: 'n-upcoming-2', title: '设计走查 · 看板与周报', body_md: '', meeting_id: 'm-upcoming-2', todo_ids: [], pinned: false, ...M },
  ]

  // ── 转录 ──────────────────────────────────────────────────────────────────
  const mkTranscript = (id, meetingId, segs) => ({
    id, meeting_id: meetingId, language: 'zh-CN', engine: 'minimax-asr',
    engine_meta: { diarization: true },
    segments: segs.map(([start_ms, end_ms, speaker_label, text]) => ({ start_ms, end_ms, speaker_label, text })),
    // 保留原始「说话人 N」标签 —— 分镜 SH-05 的画面就是它
    speaker_names: {},
    ...M,
  })

  const transcripts = [
    mkTranscript('t-q4-plan', MEETING_Q4, TRANSCRIPT_Q4),
    mkTranscript('t-onboarding', 'm-onboarding', [
      [8_000, 42_000, '说话人 1', '现在首次打开要先选 AI 运行在哪里，用户还不知道产品能干什么，就被要求做技术决策。'],
      [42_000, 88_000, '说话人 2', '流失就集中在这一步。引导面板改成右下角气泡，不拦截主界面。'],
      [88_000, 130_000, '说话人 1', '第一次录音结束后自动整理出纪要，比任何文案都有说服力。'],
      [130_000, 176_000, '说话人 2', '那引导控制在三步以内，只讲价值，不讲架构。'],
      [176_000, 220_000, '说话人 1', '首次录音的默认模板用「标准会议纪要」，别用头脑风暴。'],
      [240_000, 286_000, '说话人 2', '文案我来重写，技术名词全部去掉。'],
    ]),
    mkTranscript('t-1on1', 'm-1on1', [
      [10_000, 52_000, '说话人 1', '你这个季度手上的活太散了，三件事都没做完。'],
      [52_000, 96_000, '说话人 2', '确实。一次成稿这条线离用户最近，我想只做它。'],
      [96_000, 140_000, '说话人 1', '那就这么定：Q4 你只对一次成稿负责，每周五同步一次进度。'],
      [140_000, 182_000, '说话人 2', '会议模板的维护我交给王五。'],
      [182_000, 220_000, '说话人 1', '可以。'],
    ]),
    mkTranscript('t-infra', 'm-infra', [
      [12_000, 58_000, '说话人 1', '上周转录服务超时两次，都是 45 分钟以上的会议。'],
      [58_000, 104_000, '说话人 2', '单请求体太大了，一次性上传被网关拦掉。'],
      [104_000, 150_000, '说话人 1', '改成分片上传之后呢？'],
      [150_000, 196_000, '说话人 2', '按 5 分钟切片，50 场回归全部成功，没有复现。'],
      [196_000, 240_000, '说话人 1', '重试要带幂等键，别重复计费。'],
      [240_000, 288_000, '说话人 2', '好，这条我一起补回归用例。'],
    ]),
  ]

  // ── 纪要 ──────────────────────────────────────────────────────────────────
  const summary = (id, meetingId, templateId, contentMd) => ({
    id, meeting_id: meetingId, template_id: templateId, content_md: contentMd,
    raw_llm_output: { model: 'MiniMax-M2.7' }, generated_at: ts, model: 'MiniMax-M2.7', ...M,
  })

  const summaries = [
    summary('s-q4-plan', MEETING_Q4, 'builtin-standard', NOTE_Q4),
    summary('s-onboarding', 'm-onboarding', 'builtin-standard', NOTE_ONBOARDING),
    summary('s-1on1', 'm-1on1', 'builtin-action', NOTE_1ON1),
    summary('s-infra', 'm-infra', 'builtin-standard', NOTE_INFRA),
  ]

  // ── 会中速记 ──────────────────────────────────────────────────────────────
  const scribbles = SCRIBBLES_Q4.map(([t_ms, text], i) => ({
    id: `sc-q4-${i}`, meeting_id: MEETING_Q4, t_ms,
    text, created_at: new Date(mDates.q4.getTime() + t_ms).toISOString(),
  }))

  // ── 嵌套 OKR + 任务 ───────────────────────────────────────────────────────
  const dueIn = (n) => ymd(day(now, n))
  const T = (o) => ({
    kind: 'task', parent_id: null, scope: null, status: 'open', source: 'manual',
    sort_order: 0, notes_md: '', ...M, ...o,
  })
  const O = (o) => ({
    kind: 'objective', status: 'open', source: 'manual', sort_order: 0, ...M, ...o,
  })
  const KR = (o) => ({
    kind: 'kr', status: 'open', source: 'manual', sort_order: 0, ...M, ...o,
  })

  const todos = [
    // ── 战略 ──
    O({ id: 'o-strat-1', parent_id: null, scope: 'strategic', title: '让中文会议记录不再需要人肉整理', sort_order: 10 }),
    KR({ id: 'kr-strat-1', parent_id: 'o-strat-1', scope: 'strategic', title: '散会后 1 分钟内拿到可用的完整纪要', weight: 0.7, sort_order: 10 }),
    KR({ id: 'kr-strat-2', parent_id: 'o-strat-1', scope: 'strategic', title: '数据主权可验证', weight: 0.3, sort_order: 20 }),

    // ── Q4：一次成稿 ──
    O({ id: 'o-q4-1', parent_id: 'kr-strat-1', scope: 'quarterly', period: '2026-Q4', title: 'Q4 把一次成稿做到可日常依赖', weight: 0.7, sort_order: 10 }),
    KR({ id: 'kr-q4-1', parent_id: 'o-q4-1', scope: 'quarterly', period: '2026-Q4', title: '纪要一次成稿率 ≥ 90%', sort_order: 10 }),

    O({ id: 'o-proj-1', parent_id: 'kr-q4-1', scope: 'project', title: '打磨重新整理管线', sort_order: 10 }),
    KR({ id: 'kr-proj-1', parent_id: 'o-proj-1', scope: 'project', title: '重新整理补齐原文引用与模板切换', sort_order: 10 }),
    T({ id: 't-polish-1', parent_id: 'kr-proj-1', scope: 'project', title: '重跑 30 场历史会议做回归', status: 'done', assignee: '李四', sort_order: 10 }),
    T({ id: 't-polish-2', parent_id: 'kr-proj-1', scope: 'project', title: '补齐行动项的原文引用', status: 'done', assignee: '李四', sort_order: 20, board_col: 'done' }),
    T({ id: 't-polish-3', parent_id: 'kr-proj-1', scope: 'project', title: '把模板切换接进重新整理', status: 'open', assignee: '张三', due_date: ymd(day(nextMon, 2)), board_col: 'doing', sort_order: 30 }),

    KR({ id: 'kr-proj-2', parent_id: 'o-proj-1', scope: 'project', title: '周报草稿含风险与下周计划', sort_order: 20 }),
    T({ id: 't-report-1', parent_id: 'kr-proj-2', scope: 'project', title: '周报补齐风险与下周计划段', status: 'done', assignee: '李四', sort_order: 10 }),
    T({ id: 't-report-2', parent_id: 'kr-proj-2', scope: 'project', title: '周报一键复制 Markdown', status: 'open', assignee: '李四', board_col: 'review', sort_order: 20 }),

    O({ id: 'o-proj-2', parent_id: 'kr-q4-1', scope: 'project', title: '行动项可信与可追溯', sort_order: 20 }),
    KR({ id: 'kr-proj-3', parent_id: 'o-proj-2', scope: 'project', title: '数据去向自检覆盖全部链路', weight: 0.4, sort_order: 10 }),
    T({ id: 't-data-1', parent_id: 'kr-proj-3', scope: 'project', title: '校对局域网地址的判定', status: 'done', assignee: '王五', sort_order: 10 }),
    T({ id: 't-data-2', parent_id: 'kr-proj-3', scope: 'project', title: '数据去向自检如实标出局域网地址', status: 'open', assignee: '王五', board_col: 'review', sort_order: 20 }),
    KR({ id: 'kr-proj-4', parent_id: 'o-proj-2', scope: 'project', title: '热词表接入转录请求', weight: 0.6, sort_order: 20 }),
    T({ id: 't-hot-0', parent_id: 'kr-proj-4', scope: 'project', title: '整理产品名与人名热词表', status: 'done', assignee: '王五', sort_order: 10 }),
    T({ id: 't-hot-1', parent_id: 'kr-proj-4', scope: 'project', title: '热词表接入转录请求跑 50 场回归', status: 'open', assignee: '王五', due_date: ymd(day(nextMon, 1)), board_col: 'todo', sort_order: 20 }),

    // ── Q4：转录可用性 ──
    O({ id: 'o-q4-2', parent_id: 'kr-strat-1', scope: 'quarterly', period: '2026-Q4', title: 'Q4 中文转录可用性', weight: 0.3, sort_order: 20 }),
    KR({ id: 'kr-q4-2', parent_id: 'o-q4-2', scope: 'quarterly', period: '2026-Q4', title: '中文会议转录字准率 ≥ 95%', sort_order: 10 }),
    O({ id: 'o-proj-3', parent_id: 'kr-q4-2', scope: 'project', title: '说话人区分', sort_order: 10 }),
    KR({ id: 'kr-proj-5', parent_id: 'o-proj-3', scope: 'project', title: '转录标出说话人 1/2/3', sort_order: 10 }),
    T({ id: 't-spk-1', parent_id: 'kr-proj-5', scope: 'project', title: '接 3D-Speaker 中文声纹', status: 'done', assignee: '王五', sort_order: 10 }),
    T({ id: 't-spk-2', parent_id: 'kr-proj-5', scope: 'project', title: '说话人改名后回写转录', status: 'open', assignee: '王五', board_col: 'doing', sort_order: 20 }),

    // ── Q4：本地优先 ──
    O({ id: 'o-q4-3', parent_id: 'kr-strat-2', scope: 'quarterly', period: '2026-Q4', title: 'Q4 本地优先可验证', sort_order: 10 }),
    KR({ id: 'kr-q4-3', parent_id: 'o-q4-3', scope: 'quarterly', period: '2026-Q4', title: '内置模型全离线可用', sort_order: 10 }),
    O({ id: 'o-proj-4', parent_id: 'kr-q4-3', scope: 'project', title: '内置模型下载', sort_order: 10 }),
    KR({ id: 'kr-proj-6', parent_id: 'o-proj-4', scope: 'project', title: '下载断点续传与下载源自动切换', sort_order: 10 }),
    T({ id: 't-dl-1', parent_id: 'kr-proj-6', scope: 'project', title: '内置模型下载断点续传', status: 'done', assignee: '李四', sort_order: 10 }),
    T({ id: 't-dl-2', parent_id: 'kr-proj-6', scope: 'project', title: '下载源失败自动切换', status: 'done', assignee: '李四', sort_order: 20 }),

    // ── Inbox / 今天 ──
    T({ id: 't-inbox-1', title: '把评审结论同步给市场部', assignee: '张三', due_date: todayStr, source: 'meeting', meeting_id: MEETING_Q4, board_col: 'todo', sort_order: 100 }),
    T({ id: 't-inbox-2', title: '回复法务关于数据处理协议的邮件', due_date: dueIn(-1), board_col: 'todo', sort_order: 110 }),
    T({ id: 't-inbox-3', title: '整理客户访谈录音清单', sort_order: 120 }),
  ]

  // ── 会议待办（待确认，note Tab 顶部条带）──
  // transcript_span.quote 与上面的转录文字逐字一致
  const pendingReview = [
    {
      id: 't-pend-1', title: '热词表接入转录请求并跑 50 场回归',
      assignee: '王五', due_date: dueIn(3),
      transcript_span: { start_ms: 158_000, end_ms: 176_000, quote: TRANSCRIPT_Q4[4][3] },
      sort_order: 0,
    },
    {
      id: 't-pend-2', title: '重新整理管线补齐行动项的原文引用',
      assignee: '李四', due_date: dueIn(7),
      transcript_span: { start_ms: 310_000, end_ms: 352_000, quote: TRANSCRIPT_Q4[7][3] },
      sort_order: 1,
    },
    {
      id: 't-pend-3', title: '周报草稿补齐风险与下周计划段',
      assignee: '李四', due_date: dueIn(5),
      transcript_span: { start_ms: 500_000, end_ms: 545_000, quote: TRANSCRIPT_Q4[11][3] },
      sort_order: 2,
    },
    {
      id: 't-pend-4', title: '数据去向自检如实标出局域网地址',
      assignee: '王五', due_date: dueIn(10),
      transcript_span: { start_ms: 590_000, end_ms: 626_000, quote: TRANSCRIPT_Q4[13][3] },
      sort_order: 3,
    },
  ].map((t) => T({
    ...t, kind: 'task', scope: null, parent_id: null, status: 'pending_review',
    source: 'meeting', meeting_id: MEETING_Q4, origin_note_id: MEETING_Q4_NOTE,
  }))

  todos.push(...pendingReview)

  // ── 标签 ──────────────────────────────────────────────────────────────────
  const tags = [
    { id: 'tag-product', name: '产品', color: '#C0571E', ...M },
    { id: 'tag-eng', name: '工程', color: '#7A7168', ...M },
    { id: 'tag-q4', name: 'Q4', color: '#3A3128', ...M },
  ]
  const tagBindings = [
    { id: 'tb-1', tag_id: 'tag-product', target_type: 'todo', target_id: 't-polish-3', ...M },
    { id: 'tb-2', tag_id: 'tag-q4', target_type: 'todo', target_id: 't-polish-3', ...M },
    { id: 'tb-3', tag_id: 'tag-eng', target_type: 'todo', target_id: 't-spk-2', ...M },
    { id: 'tb-4', tag_id: 'tag-q4', target_type: 'todo', target_id: 't-hot-1', ...M },
    { id: 'tb-5', tag_id: 'tag-eng', target_type: 'todo', target_id: 't-data-2', ...M },
  ]

  // ── 知识库（会中「相关资料」卡片）────────────────────────────────────────
  const KF = '/Users/fangchen/Documents/拾贝知识库'
  const KE = (id, file, title, snippet, fullText) => ({
    id, folder: KF, path: `${KF}/${file}`, title, snippet, fullText,
    mtime: now.getTime() - 86_400_000, size_bytes: fullText.length, ...M,
  })
  const knowledgeEntries = [
    KE('ke-1', '竞品调研-会议笔记类产品.md', '竞品调研：会议笔记类产品',
      '一次成稿、原文引用、本地优先是三条被反复提到的差异点。',
      '一次成稿：散会后一次调用完成标题、纪要、行动项。原文引用：行动项必须能跳回转录原句。本地优先：录音与纪要默认不出本机。说话人区分：中文场景必须可用。周报自动化：数据都在库里，不该让用户手写。'),
    KE('ke-2', '术语表-拾贝产品词条.md', '术语表：拾贝产品词条',
      '拾贝、一次成稿、嵌套 OKR、重新整理、数据去向。',
      '拾贝 NotesToGO：本产品。一次成稿：散会后一次 LLM 调用产出标题 + 纪要 + 行动项。重新整理：用最新速记与转录重跑纪要管线。嵌套 OKR：战略 → 季度 → 项目 → 任务。数据去向：如实标出会议内容会去哪里。热词表：提高专有名词识别率。'),
    KE('ke-3', 'Q3-复盘-中文转录质量.md', 'Q3 复盘：中文转录质量',
      '专有名词识别率是纪要可信度的上限，热词表投入产出最高。',
      'Q3 复盘：中文会议转录的主要错误集中在专有名词（产品名、人名、缩写）。热词表 hotwords 接入后，专有名词错误率下降明显。周报与纪要的信任度取决于转录质量。'),
    KE('ke-4', '客户访谈-会议记录习惯.md', '客户访谈：会议记录习惯',
      '会中只记关键词，散会后靠转录补全；最怕纪要找不到出处。',
      '受访者普遍表示：会中记全反而漏听讨论。散会后最在意的是「这条待办是谁说的」，即原文引用与时间戳。周报希望一键复制到飞书。'),
  ]
  const pinnedAssistCards = [
    {
      id: 'pac-1', meeting_id: MEETING_Q4, source_entry_id: 'ke-2',
      title: '术语表：拾贝产品词条', snippet: '拾贝、一次成稿、嵌套 OKR、重新整理、数据去向。',
      path: `${KF}/术语表-拾贝产品词条.md`, ...M,
    },
  ]

  // ── 模板 ──────────────────────────────────────────────────────────────────
  const templates = [
    {
      id: 'builtin-standard', name: '标准会议纪要', icon: '📋', is_default: true, builtin: true,
      prompt_md: '你是一位专业的会议纪要秘书。请根据以下会议转录生成纪要。\n\n## 会议信息\n- 会议：{{meeting.title}}\n- 日期：{{meeting.date}}\n- 时长：{{meeting.duration}}\n- 参会人：{{transcript.speakers}}\n\n## 输出要求\n按以下结构输出 Markdown 纪要：\n1. ## 一句话结论\n2. ## 讨论要点（按议题分组，保留发言人姓名）\n3. ## 决定（Decisions）\n4. ## 行动项（提取为结构化列表，每个行动项包含：任务、负责人、截止日期、出处原话）\n\n<transcript>\n{{transcript.full}}\n</transcript>',
      ...M,
    },
    {
      id: 'builtin-action', name: '行动项优先', icon: '✅', is_default: false, builtin: true,
      prompt_md: '你是一位以行动为导向的会议秘书。这份纪要只关心「接下来谁要做什么」。\n\n## 输出要求\n1. ## 一句话结论\n2. ## 决定\n3. ## 行动项清单（穷尽所有行动项；每条：任务、负责人、截止日期、出处原话）\n\n<transcript>\n{{transcript.full}}\n</transcript>',
      ...M,
    },
    {
      id: 'builtin-brainstorm', name: '头脑风暴', icon: '💡', is_default: false, builtin: true,
      prompt_md: '你是一位善于提炼创意的会议记录者。\n\n## 输出要求\n1. ## 核心洞察\n2. ## 创意清单\n3. ## 争议与未决问题\n4. ## 后续行动\n\n<transcript>\n{{transcript.full}}\n</transcript>',
      ...M,
    },
    {
      id: 'tpl-customer', name: '客户访谈纪要', icon: '◇', is_default: false, builtin: false,
      prompt_md: '你是一位用户研究员。请把这次客户访谈整理成访谈纪要。\n\n## 输出要求\n1. ## 受访者画像\n2. ## 原话摘录（保留口语，标注时间戳）\n3. ## 痛点清单（按出现频次排序）\n4. ## 可验证的假设\n\n<transcript>\n{{transcript.full}}\n</transcript>',
      ...M,
    },
  ]

  // ── 设置 ──────────────────────────────────────────────────────────────────
  const settings = {
    ai_mode: 'cloud',
    llm_provider: 'openai-compatible',
    llm_base_url: 'https://api.minimax.io/v1',
    llm_api_key: 'sk-demo-9f3a2c7e1b4d5a6082',
    llm_model: 'MiniMax-M2.7',
    asr_mode: 'cloud',
    asr_provider: 'minimax',
    asr_base_url: 'https://api.minimaxi.com',
    asr_api_key: 'sk-demo-4c81be7a2d6f0395',
    asr_model: 'asr-1.0',
    local_llm_base_url: 'http://127.0.0.1:11434/v1',
    local_llm_api_key: '',
    local_llm_model: 'llama3.2',
    local_asr_base_url: 'http://127.0.0.1:8080/v1',
    local_asr_api_key: '',
    local_asr_model: 'whisper-1',
    builtin_llm_model: 'gemma-4-e4b',
    builtin_asr_model: 'whisper-large-v3-turbo',
    model_source: 'auto',
    hotwords: '拾贝\nNotesToGO\nOKR\n一次成稿\nKR\n重新整理',
    delete_remote_audio: true,
    theme: 'light',
    calendar_ics_urls: [],
    knowledge_folders: [KF],
  }

  const kv = {
    settings,
    onboarding_done_v1: true,
    live_caption_enabled: true,
  }

  return {
    generated_at: ts,
    now_iso: ts,
    audio_seconds: audioSeconds,
    meetings, notes, summaries, transcripts, scribbles, todos, templates,
    tags, tagBindings, knowledgeEntries, pinnedAssistCards, kv,
    polish_llm_json: POLISH_LLM_JSON,
    pre_polish_note: NOTE_Q4_PRE,
  }
}

/** 「重新整理」之前的会议状态：笔记还只是会中速记骨架，待办尚未提取 */
export function prePolishPatch(seed) {
  const note = seed.notes.find((n) => n.id === MEETING_Q4_NOTE)
  if (note) note.body_md = NOTE_Q4_PRE
  seed.todos = seed.todos.filter((t) => !(t.meeting_id === MEETING_Q4 && t.status === 'pending_review'))
  seed.summaries = []
}

/** 写 JSON 存档（promo/capture/seed/*.json） */
export async function writeSeedArchives(outDir, seed) {
  await mkdir(outDir, { recursive: true })
  const tables = ['meetings', 'notes', 'summaries', 'transcripts', 'scribbles', 'todos',
    'templates', 'tags', 'tagBindings', 'knowledgeEntries', 'pinnedAssistCards']
  for (const t of tables) {
    await writeFile(path.join(outDir, `${t}.json`), JSON.stringify(seed[t], null, 2) + '\n', 'utf8')
  }
  await writeFile(path.join(outDir, 'kv.json'), JSON.stringify(seed.kv, null, 2) + '\n', 'utf8')
  await writeFile(path.join(outDir, 'polish-llm-response.json'), JSON.stringify(seed.polish_llm_json, null, 2) + '\n', 'utf8')
  await writeFile(path.join(outDir, 'note-pre-polish.md'), seed.pre_polish_note ?? '', 'utf8')
  await writeFile(path.join(outDir, 'all.json'), JSON.stringify(seed, null, 2) + '\n', 'utf8')
}
