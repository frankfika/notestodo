# NotesToGO · 拾贝 —— 产品宣传片分镜与制作契约

> **本文件是全队唯一契约（Lead 维护，他人只读）。** 所有素材命名、时长、文案以此为准。
> 版本 v1 · 2026-10-18

## 0. 硬约束

- **禁止调用任何视频生成模型**（Sora / Veo / Kling / Runway / 即梦 等一律不用）。
- 全部画面由 **真实产品 UI 截图/录屏（Playwright 采集）** + **代码生成的排版卡片（Pillow）** + **ffmpeg 合成** 构成。
- 旁白用 **本机 macOS `say`**（本地 TTS，非视频模型），音乐用 **numpy 合成**（自研，规避版权）。
- 不编造产品能力：所有文案只能来自 `README.md` 与真实 UI。不确定的功能不写。

## 1. 成片规格

| 项 | 主片（16:9） | 竖版（9:16） |
|---|---|---|
| 分辨率 | 1920×1080 | 1080×1920 |
| 帧率 | 30fps | 30fps |
| 编码 | H.264 High, yuv420p, CRF 18, `+faststart` | 同 |
| 音频 | AAC 192kbps 48kHz stereo | 同 |
| 时长 | **90 秒 ± 3s** | 60 秒 ± 3s |
| 目标响度 | -16 LUFS（旁白清晰、音乐 -22dB 以下垫底） | 同 |

交付路径：`promo/build/out/notestogo-promo-16x9.mp4`、`notestogo-promo-9x16.mp4`、`notestogo-promo-16x9-novo.mp4`（无旁白版）、`cover-16x9.png`。

## 2. 设计真值（实测，勿凭 README 猜测）

README 里「青蓝强调色」**已过期**，以 `web/src/styles/main.css` 与真实截图像素为准：

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg` 纸 | `#FBF8F2` | 画布底色 |
| `--bg-sidebar` | `#F6F2EA` | 侧栏 |
| `--bg-raise` 抬起白 | `#FEFCF9` / `#FFFDFA` | 卡片 |
| `--line` | `#E3DFD8` | 细分隔线 |
| `--accent` **品牌橘** | **`#C0571E`** | 唯一强调色、logo 圆点、字幕关键词 |
| `--text-1` 墨 | `#3A3128` | 正文 |
| `--text-3` | `#7A7168` | 次要文字 |
| 深色底（可选） | `#26221E` | 深色卡片 |

- 字体：`PingFang SC` / `Noto Sans SC`（`/System/Library/Fonts/NotoSansSC-Variable.ttf` 可用）。数字用等宽感。
- 气质：暖纸、克制、大留白、4pt 网格、动效 150–250ms ease-out。**不用 emoji**，符号用 `● ▣ ◆ ✎ ✓`。
- 视觉母题：`●` 橘色圆点（品牌/录制/状态）、细横线、纸面质感。

## 3. 分镜表（时间轴为构建目标，实际由 `build/timeline.json` 数据驱动）

VO 行号 = `promo/audio/vo/vo-NN.wav`。`CAP` = 屏幕下方烧入字幕（与 VO 同文，便于静音观看）。

### SH-01 钩子 · 0:00–0:08（8s）
- **画面**：纸色底 + 极淡横格线。居中大字逐句浮现：
  「开会时，你到底是在参与讨论，」「还是在抄笔记？」
  末 1.5s 小窗（今天页静帧）从下方缓推入。
- **VO-01**：「开会的时候，你是在参与讨论，还是在忙着抄笔记？」
- **CAP**：开会时，你在讨论，还是在**抄笔记**？
- **素材**：`stills/today.png`（用于小窗）、`assets/brand/bg-paper-1920x1080.png`

### SH-02 品牌亮相 · 0:08–0:15（7s）
- **画面**：字标 `NotesToGO`（墨色）+ 橘点 + 副标「拾贝 · 会议速记 × 嵌套 OKR」；下方一句「会中只记关键词，散会后一键成稿」。
- **VO-02**：「NotesToGO 拾贝。会中只记关键词，散会后一键成稿。」
- **CAP**：**NotesToGO** 拾贝 · 会中只记关键词，散会后一键成稿
- **素材**：`assets/brand/title-card-1920x1080.png`

### SH-03 一键录音 + 实时字幕 · 0:15–0:28（13s）
- **画面**：真实录屏 `clips/record-start.webm`（今天页点「● 开始录音」→ 进入会中页）→ 叠 `clips/live-caption.webm`（左速记敲字、右实时字幕、电平条）。
- **VO-03**：「按一个快捷键就能开录。左边只敲关键词，右边实时字幕自己长出来；散会后，这几个字就够定位一整段讨论。」
- **CAP**：**⌘⇧R** 一键开录 · 会中只记关键词，回车即存
- **快捷键真值（已实测）**：`web/src/App.tsx:43` 全局快捷键是 **⌘⇧R**（README:13 亦同）。**不得写 ⌘R**——浏览器里 ⌘R 是刷新页面。旁白不念符号，符号只出现在字幕上（`say` 念不出 ⌘⇧）。
- **要点标注**：`速记优先 · 实时字幕 · 电平可见`（lower-third，来自 `assets/brand/lower-third-live.png`）
- **素材**：`clips/record-start.webm`、`clips/live-caption.webm`、`stills/live-meeting.png`

### SH-04 散会一次成稿 · 0:28–0:42（14s）
- **画面**：`clips/polish.webm`：会议详情 → 点「重新整理」→ 笔记 Tab 出现「一句话结论 / 讨论要点 / 决定 / 行动项」，顶部待办确认条带**原文引用**与建议 KR → 点「全部确认」。
- **VO-04**：「散会后只有一次 AI 调用：标题、完整纪要、行动项一起给你。每条待办都带原文引用——找不到出处的，也不会丢。」
- **CAP**：一次调用 = 标题 + 纪要 + 待办 · 每条带**原文引用**
- **素材**：`clips/polish.webm`、`stills/meeting-note.png`、`stills/meeting-todo-confirm.png`

### SH-05 说话人区分 · 0:42–0:49（7s）
- **画面**：转录 Tab 滚动，逐段显示「说话人 1 / 说话人 2」+ 时间戳；高亮一段。
- **VO-05**：「转录带说话人区分，谁在什么时候说了什么，一目了然。」
- **CAP**：转录带**说话人区分** · 谁在什么时候说了什么
- **素材**：`clips/transcript-speakers.webm`、`stills/meeting-transcript.png`

### SH-06 落到 OKR · 0:49–1:03（14s）
- **画面**：任务页 Focus → Quarter → Strategy 三视图切换；OKR 树展开，进度按权重汇总；把 Inbox 任务「挂到 KR」。
- **VO-06**：「行动项不会躺在收件箱里。挂到对应的 KR 上，进度按权重逐级汇总：战略、季度、项目、任务，一条链到底。」
- **CAP**：**嵌套 OKR** · 战略 → 季度 → 项目 → 任务
- **素材**：`clips/okr-views.webm`、`clips/okr-attach.webm`、`stills/okr-strategy.png`

### SH-07 看板 + 自动周报 · 1:03–1:14（11s）
- **画面**：看板四列拖拽换列（待办/进行中/评审/完成）→ 切到周报页，Markdown 草稿已生成，可翻周。
- **VO-07**：「项目看板拖一下就换列；到了周五，周报已经替你写好了，复制就能贴。」
- **CAP**：看板拖拽换列 · **自动周报**一键复制
- **素材**：`clips/board-drag.webm`、`clips/report.webm`、`stills/board.png`

### SH-08 本地优先 · 完全离线 · 1:14–1:25（11s）
- **画面**：设置页「AI 运行在哪里」三选一（本机内置 / 云端 API / 自建服务）→ 内置模型下载进度 → 「数据去向」自检卡显示「会议内容未离开本机」。
- **VO-08**：「不想把会议内容传到云端？装上桌面版，模型可以完全跑在你自己电脑上，断网也能转录、也能写纪要。数据去哪了，页面上如实告诉你。」
- **CAP**：**桌面版**内置模型 · 断网可用 · 数据去向如实自检
- **事实边界（勿越界）**：内置模型推理在**桌面端**（`web/src-tauri/src/builtin/`）；`web/src/lib/builtinModels.ts:15` 明确浏览器版没有该能力、UI 会如实提示「需要桌面版」。所以画面呈现「AI 运行在哪里」三选一 +「数据去向」自检即可，**不得**暗示浏览器网页版就能离线推理。自检卡真实文案是「✓ 会议内容全部留在本机」（`SettingsPage.tsx:1003`），以真实 UI 为准，不要照契约自造。
- **素材**：`clips/settings-ai.webm`、`stills/settings-ai.png`、`stills/data-flow.png`

### SH-09 多端 + 数据主权 · 1:25–1:32（7s）
- **画面**：iPhone + iPad 机身框内真实界面（今天 / 看板）并排滑入；右下角「导出 .zip」按钮脉冲。
- **VO-09**：「手机、iPad、Mac 都能用，加到主屏就是原生应用；所有数据一键导出，永远是你的。」
- **CAP**：PWA 可安装（iPhone / iPad / Mac）· 一键导出 **.zip**
- **素材**：`stills/mobile-today.png`、`stills/ipad-board.png`、`clips/export.zip.webm`

### SH-10 收尾 · 1:32–1:40（8s）
- **画面**：纸色底，字标 + 一句 slogan，底部 `github.com/frankfika/notestodo` + 「本地优先 · 开源」。
- **VO-10**：「NotesToGO 拾贝。本地优先，开源。今天就试试。」
- **CAP**：**github.com/frankfika/notestodo** · 本地优先 · 开源
- **素材**：`assets/brand/end-card-1920x1080.png`

> 转场：SEG 之间统一 0.5s crossfade（`xfade=transition=fade`）；SH-04→05 与 SH-06→07 用 0.35s 快速叠化以保持节奏。整体推进用 Ken Burns（缓慢 1.00→1.06 缩放）。

## 4. 素材接口契约

### 4.1 `capture/`（负责人：capture）
- **静帧**：`capture/stills/<name>.png`，viewport **1920×1080**、`deviceScaleFactor: 2` → 实际 **3840×2160**（正好 16:9，供 Ken Burns 裁切）。移动静帧：viewport 390×844、dsf 3 → 1170×2532。
- **录屏**：`capture/clips/<name>.webm`，`recordVideo.size = {width:1920,height:1080}`。每条 4–9s，结束时**停顿 ≥0.8s**（便于裁剪）。
- **必须清场**：关掉新用户引导浮层、关闭任何随机 toast；鼠标移到画面外，不要出现 Playwright 焦点框。
- **必须富数据**：禁止空状态（"今天没有要处理的事"）出现在成片里。用 `capture/seed/*.json` 直接写 IndexedDB，字段严格照 `web/src/types.ts`。
- **清单元数据**：`capture/MANIFEST.json`：
```json
{ "generated_at": "...", "stills": [{"name":"today","path":"stills/today.png","w":3840,"h":2160}],
  "clips": [{"name":"polish","path":"clips/polish.webm","duration_s":7.2,"w":1920,"h":1080,
             "content":"会议详情→重新整理→笔记Tab→全部确认"}] }
```
- 允许的做法：读 `web/tests/*.spec.ts` 里已有的播种/点击/导航写法并复用（不要重写一套）。

### 4.2 `assets/brand/`（负责人：brand）
- 全尺寸 **1920×1080 PNG**，透明处用 `RGBA`；文件名见分镜表。
- 必须与第 2 节设计真值一致（纸色底 `#FBF8F2`、橘 `#C0571E`、PingFang/Noto Sans SC）。
- 附 `assets/brand/MANIFEST.json`：每个文件的用途、可用区域（安全框建议四周留 96px）。
- 附带 `cover-16x9.png`（1920×1080，用于文章头图 / 视频封面，含字标 + 一句话 + 橘点）。

### 4.3 `audio/`（负责人：audio）
- **旁白**：`audio/vo/vo-01.wav … vo-10.wav`，48kHz 单声道（合成时转立体声），**逐句独立文件**，句首句尾各留 150ms 静音。
- **清单**：`audio/vo-manifest.json`：`[{"id":"vo-01","path":"vo/vo-01.wav","duration_s":4.2,"text":"..."}]`
- **音乐**：`audio/music/bed.wav`，48kHz 立体声，时长 ≥ 100s，结构 = 8s 引入 / 中段稳态 / 最后 6s 收尾；**无版权风险（自研合成）**。
- **混音**：`audio/mix/master.wav` = 音乐 -22dB 垫底 + 旁白 -16 LUFS，无明显削波（`ffmpeg -af astats` 峰值 < -1dBTP）。

### 4.4 `build/`（负责人：Lead）
- `build/timeline.json`（由 VO 实测时长数据驱动）、`build/render.sh`、`build/out/*`。

## 5. 验收标准（QA 独立复核）

1. 主片时长 90s ± 3s，竖版 60s ± 3s；`ffprobe` 分辨率/帧率/像素格式/has_audio 全部符合第 1 节。
2. **能拖动播放**：QuickTime / `ffplay` 可播，`moov` 在文件头（faststart）。
3. 字幕**不遮挡**关键 UI、不超安全框、在 100% 与 50% 缩放下均可读；无错别字。
4. 画面里**不得出现**空状态、"0" 计数、加载中、报错 toast、引导浮层、鼠标焦点框。
5. 品牌一致：橘色 `#C0571E`、纸底 `#FBF8F2`、无 emoji、字体为 PingFang/Noto Sans SC。
6. 音画同步：每条字幕出现时间与对应 VO 偏差 < 300ms；无爆音（峰值 < -1dBTP）。
7. 事实准确：片中每一项能力都能在 README 或真实 UI 中找到出处；QA 需逐条给出出处。
