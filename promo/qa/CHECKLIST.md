# NotesToGO 宣传片 · 独立验收 CHECKLIST（v2 · 手段已按「无视觉模型」重建）

> 验收负责人：`verify`（QA，独立复核，只读他人产物；写作用域仅 `promo/qa/**`）
> 依据契约：`promo/STORYBOARD.md` **第 5 节 7 条**（阈值另见 §1、§2）
> v2 变更原因：`mcp__MiniMax__understand_image` 额度耗尽（实测返回 Token Plan 用量上限）。
> 本会话模型**不接受图片输入**（实测 `read_image` 报 `model "ark-code-latest" does not
> declare image input`），两条替代视觉通道也已实测排除：`volces-ark/glm-5-3-flash-260828`
> 与 `minimax-cn/MiniMax-M3` 子代理均返回 `CANNOT_SEE`（后者直接失败）。
> ⇒ **本项目当前没有任何可用视觉通道**，故 v2 把每条标准重新标注为「可自动验证 / 仅间接证据 / 无法验证」。

---

## 0. 状态与结论边界（**先读这一段**）

| 标准 | 自动化程度 | 本会话能否给出 PASS |
|---|---|---|
| 1 时长与规格 | ✅ 全自动 | 能 |
| 2 可拖动（faststart） | ✅ 自动（解析 mp4 box） | 能（"ffplay 实际拖动"仍建议人工 1 次） |
| 3 字幕：错别字 | ✅ 双层自动 | 能 |
| 3 字幕：安全框 | ✅ 实测 bbox 边距 | 能 |
| 3 字幕：**不遮挡关键 UI** | ❌ 需视觉 | **不能** |
| 3 字幕：50% 缩放下可读 | 🟡 字高/对比度可量化 | 部分（字号可比，观感需人眼） |
| 4 画面禁止出现（空状态/0/加载中/toast/浮层/焦点框） | 🟡 仅颜色签名 + 源数据推断 + OCR 正向 | **不能**（见 §4） |
| 5 品牌一致 | ✅ 覆盖率可测 + 源码可查 | 能（字号/观感除外） |
| 6 音画同步 / 无爆音 | ✅ 全自动 | 能 |
| 7 事实准确 | ✅ 可核对到行号 | 能，但有 4 条「契约漂移」需 Lead 先收敛 |

> **纪律**：上表标 ❌/🟡 的项，我不会写成 PASS，也不会用"看起来没问题"糊过去。
> 成片落地后我会给出**逐项实测数字 + 明确的"未验证"标注**，把判断权交回 Lead。

---

## 1. 手段替换表（原视觉项 → 现可执行项）

| 原 CHECKLIST 要求 | 替代手段 | 能力 | **已知局限（不可忽略）** |
|---|---|---|---|
| 用 `understand_image` 逐帧看是否空状态/0/加载中/报错/浮层 | ① 颜色签名像素检测 `check_frames.py`（危险红 #B7493F、饱和蓝）② 源数据与守卫条件推断 ③ OCR 词表正向扫描 | 检出**大面积紧凑**的红/蓝异常块 | 空状态/加载中/引导浮层**没有固定颜色签名**；细焦点框（≈200×3px）低于可靠门槛；OCR 漏认严重 |
| 用 `understand_image` 逐字核对错别字 | `verify_captions.py`（像素同一性，**Lead 提供**）+ `check_spec.py caps`（**对照契约**） | 见 §2 | 单独用 verify_captions **抓不到文案本身写错**（见 §2.1） |
| 用 `understand_image` 看字幕是否遮挡关键 UI | **无替代**（遮挡是空间语义判断） | — | **必须**由具备视觉能力的人/模型确认，或 Lead 书面接受该风险 |
| 用 `understand_image` 判断 emoji / 字体 | 源码级：扫所有上台文字的字符串查 emoji 码点；字体查生成脚本的字体路径 | 强（确定性） | 真实 UI 截屏里若产品自己画了 emoji，源码扫不到（但 README:89 规定产品用文字符号，不用 emoji） |
| 目测安全框 | `check_frames.py` 量字幕实心笔画 bbox → 四边留白像素/百分比 | 强（可复算） | 只覆盖**字幕**；其它元素（lower-third、水印）需各自量 |

---

## 2. 三个工具 + 我的校准结论（都已实跑，可复算）

### 2.1 `promo/build/tools/verify_captions.py`（Lead 提供，硬手段）
- **10/10 通过，全部 `笔画不一致率 = 0.0000`**（我用 16x9 探针时间轴跑，覆盖全部 10 个分镜）。
- ⚠️ **必须配对的坑（我实测踩到并绕开）**：它从 `--timeline` 取**文案**、从 `--layout` 取**几何**。
  而 `promo/build/timeline.json` 是**单文件、按 layout 覆盖写**的——当前磁盘上那份是
  **9x16（6 分镜 / total_s=61.452）**，直接按 Lead 文档原样调用只会覆盖 **6/10** 个分镜
  （实测输出 `6/6 通过`）。我用 `probe_timeline.py` 把 16x9 时间轴重生成到 `promo/qa/_probe/`
  后才拿到 10/10。
- ⚠️ **能力边界（重要）**：它比对的两侧都用**同一来源**（`timeline.json` 的 `cap`）。
  所以它证明的是「**成片像素 == 源码文案**」（渲染/编码没把字画坏），
  **不能**证明「源码文案本身没写错 / 与契约一致」——那种情况下两边一致地错，照样 100% 通过。
  ⇒ 必须叠加 §2.2 的 `caps` 子命令，才算完成"错别字"核对。

### 2.2 `promo/qa/check_spec.py caps`（**新增，补上 Lead 工具抓不到的那一环**）
把 timeline 的 cap 与 `STORYBOARD.md` §3 的 `**CAP**：` 逐条 normalize（去 `**` 加粗与空白）后比对。
实测结果：**6/10 一致，4 条漂移** → 见 §5.2（这是**契约漂移**问题，不是错别字）。

### 2.3 `promo/build/tools/ocr.py`（Lead 提供）
- 可用（tesseract 5.5.2，`chi_sim`/`eng` 均在）。
- ⚠️ **实测到假 MISS**：对 SH-08 帧 `--expect "桌面版内置模型"` 返回 **MISS**，
  而同一处 `verify_captions` 已证明像素与文案**完全一致（不一致率 0.0000）**。
  ⇒ 证实 Lead 的警告：**OCR 的"没找到"绝不能当 PASS 依据**；只能当"找到了"的**正向**证据。
  故本 CHECKLIST 中 OCR 仅用于：危险词表正向命中 + 粗定位，**不作任何 PASS 判定**。

### 2.4 `promo/qa/check_frames.py`（**新增**，非目视帧取证）
颜色签名 + 字幕 bbox/安全框 + 边缘溢出。**校准过程（含一次自我纠错）**：
- 初版阈值 `tol=36 / 0.02%` → **10 帧全部假报警**：暖色真实 UI 的散落抗锯齿像素被认成"危险红"，
  bbox 横跨 1900×960 但像素占比仅 0.02–0.38%（明显不是 toast 形状）。
- 修正为 `tol=22` + **紧凑性**（bbox ≤ 画面 35%）+ **面积门槛 0.5%**（真实 toast ≈ 400×60px ≈ 1.16%）
  → **10 帧 0 条可疑项**（不再假报警）。
- 结论：该工具只在"检出大面积紧凑异常色块"时可信；**安静 ≠ 画面干净**。

### 2.5 `promo/qa/probe_timeline.py`（**新增**）
只读 import `promo/build/render.py` 的纯函数 `build_timeline()`，把指定 layout 的时间轴写到
`promo/qa/_probe/`，**不碰 Lead 的 `timeline.json`**。解决上面的覆盖坑。

---

## 3. 已完成的**预检**（用 `_tmp/preview/` 的 10 张 16x9 合成帧，非成片）

> 这是准备阶段的预检，**不等于**成片验收；但已能证明工具链有效、并提前暴露问题。

| 项 | 实测结果 |
|---|---|
| 16x9 时间轴（我重生成） | 10 分镜 / `total_s = 90.000s` ✅（`sum(dur) - sum(xfade) = 90.000`） |
| 分镜覆盖 | 10/10 覆盖契约 §3 全部分镜 ✅ |
| 字幕像素同一性 | **10/10**，`笔画不一致率 = 0.0000` ✅ |
| 字幕 vs 契约文案 | **6/10** ❌ 4 条漂移（SH-02/05/07/10）→ §5.2 |
| 字幕底边距（实心笔画） | **83–88 px**（SH-09/10 = 83，其余 87–88） |
| 字幕左右边距 | **509–677 px**（居中，远大于任何安全框） |
| 品牌橘覆盖率 | **0.59% – 10.30%**（10/10 帧均检出）✅ |
| 纸色 #FBF8F2 覆盖率 | 30.81% – 84.91%（录屏分镜偏低属正常） |
| 危险红紧凑块 / 饱和蓝 | **0 条**（10 帧） |
| 契约的 9x16 时间轴 | 6 分镜 / total_s 61.452（∈ [57,63] ✅） |

---

## 4. 第 5 节 7 条 → 检查项（v2）

### ✅ 标准 1 · 时长与规格 —— 全自动
```bash
$PY promo/qa/check_spec.py check promo/build/out/*.mp4 --skip-frames -v
```
- [ ] **1.1–1.8** `S1.1`–`S1.8` 全 PASS（分辨率/帧率/`yuv420p`/h264 High/aac 48k 2ch/时长/响度）
- [ ] **1.9** `renderflags` 确认 `-crf 18`（CRF 无法从成片反查）
<sub>阈值：主片+无旁白版 90±3s；竖版 60±3s；响度 -16 LUFS ±2 LU（容差为 derived()）</sub>

### ✅ 标准 2 · faststart —— 全自动
- [ ] **2.1** `S2.1` PASS：顶层 box 顺序 `ftyp → moov → … → mdat`（自己解 box，不信 ffmpeg 自述）
- [ ] **2.2** `ffplay` 打开主片可即时起播、可拖到 30s/60s（**人工 1 次**，记时间点）

### 🟡 标准 3 · 字幕
- [ ] **3.1 错别字（双层）**
  - [ ] **3.1a** `verify_captions.py --frames <preview> --timeline promo/qa/_probe/timeline-16x9.json --layout 16x9` → 期望 **10/10、不一致率 0.0000**（像素 == 源码文案）
  - [ ] **3.1b** `check_spec.py caps` → 期望 **10/10 与契约一致**（当前 **6/10**，见 §5.2）
  - [ ] **3.1c** 半角标点扫描（Python 版，**别用 `grep -P`**：macOS BSD grep 不支持，实测报 `invalid option -- P`）
- [ ] **3.2 安全框** `check_frames.py` 量 bbox：底边距 ≥ ?（见下方口径争议）
- [ ] **3.3 不遮挡关键 UI** → **❌ 本会话无法验证**。需视觉确认或 Lead 书面接受
- [ ] **3.4 50% 缩放下可读** → 🟡 记录字幕实心笔画高度（px）与对比度；"观感可读"需人眼

> **口径争议（请 Lead 裁决，我不擅自判 FAIL）**：契约 §4.2 的 96px 安全框是给
> **品牌素材**的可用区域，未对**烧入字幕**规定数值。实测字幕底边距 **83–88px**：
> 高于 5% 行动安全区（1080×5% = **54px**），但低于 96px。
> 若按 96px 判 → 10/10 全 FAIL；若按 5%/行动安全 → 全部 OK。**契约需明确一句**。

### 🟡 标准 4 · 画面禁止出现 —— **只能给受限证据**
- [ ] **4.1 空状态**：间接证据（**不是**目视确认）——空状态由 `length === 0` 守卫
  （`TodayPage.tsx:147`：`due.length + inbox.length === 0 ?`），而种子数据富足：
  `todos.json` **39** 条、`meetings.json` **6** 条、`notes.json` **7** 条、`scribbles.json` **7** 条、
  `transcripts.json` **4** 条 ⇒ 守卫应为假。**但无法排除子计数器（如某 KR 进度 0%、空看板列）**。
- [ ] **4.2 `0` 计数**：同上，仅间接
- [ ] **4.3 加载中**：需排除 `MeetingDetailPage.tsx:267` 的 `AI 正在整理笔记…`（`inFlight || polishing`）
  与 `waiting_model` 状态。SH-04 必须是"整理完成后"的帧——间接可查（`summaries.json` 4 条、`note-pre-polish.md`）
- [ ] **4.4 报错 toast**：`check_frames.py` 危险红紧凑块 = 0（**正向证据**，安静≠没有）
- [ ] **4.5 引导浮层**：无签名，**无法验证**
- [ ] **4.6 鼠标焦点框**：饱和蓝 = 0.0000（弱正向证据；细焦点框低于门槛）
- [ ] **4.7 浏览器 UI 痕迹**：无签名，**无法验证**
- [ ] **4.8** OCR 危险词表正向扫描：`check_frames.py --ocr`（仅"命中即问题"）

### ✅ 标准 5 · 品牌一致
- [ ] **5.1** 品牌橘 `#C0571E` 覆盖率（预检：0.59–10.30%，10/10 帧检出）
- [ ] **5.2** 纸色 `#FBF8F2` 覆盖率（预检：30.8–84.9%）
- [ ] **5.3** 无**大面积**过期青蓝（README:87 的 `#24727A`）：预检 10 帧均 < 0.5% ✅
- [ ] **5.4 无 emoji**：源码级扫描所有上台文案的 emoji 码点（确定性）
- [ ] **5.5 字体**：`video.py:43` `FONT_PATH = /System/Library/Fonts/NotoSansSC-Variable.ttf`；
  `make_brand_assets.py:84-86` 用 Noto Sans SC / PingFang SC ⇒ 源码级 PASS
- [ ] **5.6** 录屏分镜为暖纸浅色（预检纸色 30.8–77.9%，SH-07 最低 30.8%）

### ✅ 标准 6 · 音画同步 / 无爆音 —— 全自动
```bash
$PY promo/qa/check_spec.py sync --video promo/build/out/notestogo-promo-16x9.mp4
```
- [ ] **6.1** `S6.1` 真峰值 < -1.0 dBTP（`loudnorm.input_tp` 与 `ebur128` 取更差者）
- [ ] **6.2** 整合响度 -16 ±2 LUFS
- [ ] **6.3** `S6.5` 每条字幕 |偏差| **< 300ms**
- [ ] **6.4** `ncc ≥ 0.15`（低于此该条不可作证据，须人工核听）
- [ ] **6.5** 与**标称口径**的偏离：Lead 定稿 `cap_in = 分镜起点 + VO_LEAD(0.40) + speech_start(0.150) − 0.08`
  ⇒ 标称 **−80ms（字幕领先人声）**，`sync` 会同时报「|偏差|」与「与标称的偏离」
- [ ] **6.6** 无爆音（`astats` `Flat factor`/`Peak count` 旁证 + 人工听 0s/28s/74s/片尾）
- [ ] **6.7** 音乐未盖过旁白
> 注：`audio/mix/master.wav` 只是预览，**不作验收对象**（Lead 已声明）；只验成片音轨。

### ✅ 标准 7 · 事实准确
- [ ] **7.1** §6 事实核查表每行都有 README 行号或 `文件:行号`
- [ ] **7.2** 无「无出处」条目
- [ ] **7.3** 片中数字/型号逐一核对（§6 末表）
- [ ] **7.4** 无 README 明确否认的能力（浏览器版离线推理等）——PRE-RISK-03 已整改，待复核
- [ ] **7.5** 无契约外新承诺
- [x] **7.6** `check_spec.py caps` **10/10 ✅**（第 2 轮已收敛；原 6/10 见 §5.2）

---

## 5. 本轮新增发现

### 5.1 ❌ **契约交付物缺失：`promo/capture/MANIFEST.json`**
契约 §4.1 明确要求产出 `capture/MANIFEST.json`（含每条静帧/录屏的实测时长与内容描述）。
**实测：文件不存在**（`promo/capture/` 下只有 `stills/`(19 个) `clips/`(12 个) `seed/`(14 个)）。
影响：无法独立核对「哪个 clip 对应哪个分镜 / 内容是什么 / 时长是否 4–9s、结尾是否停顿 ≥0.8s」，
也无法据此复核标准 7 的画面出处。**请 capture 补交。**
（对照：`assets/brand/MANIFEST.json` 存在 ✅ 15986 bytes；`audio/vo-manifest.json` 存在 ✅）

### 5.2 ✅ **已收敛（第 2 轮复核）：字幕文案与契约 §3 的 4/10 漂移**
**修复确认**：Lead 把契约 §3 的 `- **CAP**：` 程序化改写成实现值（改 9 条），
实测 `caps` → `S7.1/S7.2/S7.3` 全 PASS（**10/10 完全一致**）。
另独立复核：契约 §3 的 **10 条 VO 文案 vs `audio/vo-manifest.json` 归一化后 10/10 完全一致**
（含长度一致，无截断）。下表为**修复前**记录，保留作审计痕迹。

| 分镜 | 契约 §3 CAP（修复前） | 成片实际 cap | 事实性 |
|---|---|---|---|
| SH-02 | `NotesToGO · 拾贝` | `NotesToGO 拾贝 · 会中只记关键词，散会后一键成稿` | ✅ 有出处（README:3、§3 画面行） |
| SH-05 | `说话人 1 / 说话人 2 · 时间戳可跳转` | `转录带说话人区分 · 谁在什么时候说了什么` | ✅ 有出处（README:27）；但**丢了**"时间戳可跳转"（该能力真实存在，`MeetingDetailPage.tsx:55`） |
| SH-07 | `看板拖拽 · 自动周报 · 一键复制` | `看板拖拽换列 · 自动周报一键复制` | ✅ 有出处（README:18,19） |
| SH-10 | `github.com/frankfika/notestodo` | `github.com/frankfika/notestodo · 本地优先 · 开源` | ✅ 有出处（README:5,97,200-202） |

**均无事实错误**，但契约自称「全队唯一契约…文案以此为准」，实现已按新文案烧入。
**建议**：Lead 直接更新 §3 的这 4 条 CAP（最省事，渲染已完成）；否则需改文案重渲。

### 5.3 ⚠️ **工具链健壮性：`timeline.json` / `subtitles-zh.srt` 按 layout 覆盖写**
- `promo/build/timeline.json` 现为 **9x16**（6 分镜）；16x9 的 10 分镜版已被覆盖。
- `promo/script/subtitles-zh.srt` 现为 **16x9**（10 条，与我的探针时间轴逐字一致），
  但下一次 9x16 渲染会把它覆盖成 6 条。我已把 16x9 版**快照**到
  `promo/qa/_probe/subtitles-zh-16x9.snapshot.srt`，9x16 版快照 `_probe/timeline-9x16.as-found.json`。
- **后果**：任何"事后按文件复核"的动作都可能拿到错版本的输入（我的 `verify_captions` 首跑就只覆盖了 6/10）。
- **建议**：`render.py` 改为按 layout 分别输出 `timeline-<layout>.json` / `subtitles-<layout>.srt`。

### 5.4 ⚠️ 契约 §3「CAP 与 VO 同文」与实际不符（文档口径，LOW）
实测 CAP 是 VO 的**精简版**，非同文。例：
VO-01 =「开会的时候，你是在参与讨论，还是在忙着抄笔记？」 vs CAP-01 =「开会时，你在讨论，还是在抄笔记？」
§5.3 并未要求同文（只要求不遮挡/可读/无错别字），故**不判 FAIL**，建议 §3 把该括注改为
「CAP 为 VO 的精简版（静音可看）」。

### 5.5 ⚠️ 契约 §2 的 `--text-1`/`--text-3` 与 main.css 不完全一致（文档口径，LOW）
契约 §2 称这些"实测"自 `main.css`，但：
`--text-1` 契约 `#3A3128` vs `main.css:16` `oklch(25% 0.014 60)` = **#27201B**；
`--text-3` 契约 `#7A7168` vs `main.css:18` `oklch(52% 0.013 65)` = **#6E6861**。
（`--bg`/`--line`/`--accent` 三项则**精确吻合**。）
成片用的是契约值（`video.py:38-41`：`INK=(58,49,40)`、`INK2=(122,113,104)`），故**不影响成片**，
仅 §2「实测」措辞不准；建议注明"视频侧墨色为契约手调值"。

---

## 6. 事实核查表（能力宣称 → 出处）

**状态**：`✅ 有出处` / `⚠️ 待核` / `❌ 无出处`。**CAP 以 §5.2 的实际烧入文案为准。**

| # | 分镜 | 片中宣称 | 出处 | 状态 |
|---|---|---|---|---|
| C-01 | SH-02 | NotesToGO / 拾贝 | README.md:1、:5 | ✅ |
| C-02 | SH-02 | 会中只记关键词，散会后一键成稿 | README.md:3、:13 | ✅ |
| C-03 | SH-03 | ⌘⇧R 一键开录 | README.md:13；`web/src/App.tsx:43,52`；真实 UI 文案 `TodayPage.tsx:150`（`按 ${mod()}⇧R 开一场会议`） | ✅ **（原 ⌘R 已整改）** |
| C-04 | SH-03 | 回车即存 | README.md:13（回车即存并带时间锚点） | ✅ |
| C-05 | SH-03 | 左速记 / 右实时字幕 / 电平可见 | README.md:13、:15、:11 | ⚠️ 待核（画面） |
| C-06 | SH-04 | 一次调用 = 标题 + 纪要 + 待办 | README.md:13 | ✅ |
| C-07 | SH-04 | 每条带原文引用 | README.md:13；`MeetingDetailPage.tsx:627,651`（全部确认） | ✅ |
| C-08 | SH-04 | 找不到出处的待办也不会丢 | README.md:12（三级回退） | ✅ |
| C-09 | SH-05 | 转录带说话人区分 | README.md:27；`BuiltinModels.tsx:196-197`；`MeetingDetailPage.tsx:749` | ✅ |
| C-10 | SH-05 | 谁在什么时候说了什么 | README.md:27 | ✅ |
| C-11 | SH-05 | ~~时间戳可跳转~~（实际未烧入，能力真值存在） | `MeetingDetailPage.tsx:55,129,288` | ✅（未使用） |
| C-12 | SH-06 | 嵌套 OKR · 战略 → 季度 → 项目 → 任务 | README.md:14 | ✅ |
| C-13 | SH-06 | 进度按权重逐级汇总 | README.md:14 | ✅ |
| C-14 | SH-07 | 看板拖拽换列 | README.md:18 | ✅ |
| C-15 | SH-07 | 自动周报一键复制 | README.md:19；`ReportPage.tsx:90`（复制 Markdown） | ✅ |
| C-16 | SH-08 | 桌面版内置模型 | README.md:26；`builtinModels.ts:15` | ✅ **（载体错位已整改）** |
| C-17 | SH-08 | 断网可用（离线转录/纪要） | README.md:26（桌面端 `src-tauri/src/builtin/`） | ⚠️ 待复核画面无"网页版可离线"暗示 |
| C-18 | SH-08 | 数据去向如实自检 | README.md:26；`SettingsPage.tsx:992-1003`；`lib/dataFlow.ts:4` | ✅ |
| C-19 | SH-09 | PWA 可安装（iPhone/iPad/Mac） | README.md:5、:23；`main.tsx:18`（注册 SW） | ✅ |
| C-20 | SH-09 | 一键导出 .zip | README.md:22；`SettingsPage.tsx:313,750` | ✅ |
| C-21 | SH-10 | 本地优先 | README.md:97、:5 | ✅ |
| C-22 | SH-10 | 开源 | README.md:200-202（MIT）；`git remote -v` = github.com/frankfika/notestogo.git | ⚠️ 仓库是否 public 待联网核 |
| C-23 | SH-10 | github.com/frankfika/notestogo | 本地 remote 一致 | ⚠️ 链接可达性待联网核 |

**具体数字核对（SH-08）**：Whisper Large v3 Turbo 574MB / Small 190MB（README:26 +
`builtinModels.ts:41,46` 的 `574_041_195` / `190_085_487`）；说话人区分约 30MB（README:27 +
`builtinModels.ts:57`）；6.8s/30s/2s（README:28）。
⚠️ Gemma 4 E4B 5.2GB / E2B 3.4GB / 12B 7.0GB 需与 `builtinModels.ts` CATALOG 逐条对账（成片若未出现可跳过）。

---

## 7. 预识别风险复核（v1 的 PRE-RISK）

| ID | v1 内容 | 复核结果 |
|---|---|---|
| PRE-RISK-01 | ⌘R 与真实快捷键不符 | ✅ **已整改**：契约 §3 CAP-03 与 VO-03 已改，新增「快捷键真值（已实测）」段；`timeline.json` cap 已为 `⌘⇧R`；vo-03 已重出。待成片复核字幕实际烧入 |
| PRE-RISK-02 | README:87 青蓝过期 | ✅ **已确认**：成片用 `#C0571E`（`video.py:41`）。预检 10 帧无大面积青蓝 |
| PRE-RISK-03 | SH-08 载体错位 | ✅ **已整改**：契约 §3 新增「事实边界（勿越界）」段；CAP-08 改「**桌面版**内置模型」；VO-08 改「装上桌面版…」。待成片复核画面无"网页版可离线"暗示 |
| PRE-RISK-04 | SH-08 卡片文案若照契约自造 | ⚠️ **仍未收敛**：§3 的**画面描述行**依旧写「…自检卡显示「会议内容未离开本机」」，而同段「事实边界」已正确注明真实文案是「✓ 会议内容全部留在本机」。两者自相矛盾，建议删掉画面描述里那句 |
| PRE-RISK-05 | 导出注释过期 | ➖ 不影响成片（UI 文案与 README:22 一致） |
| PRE-RISK-06 | 实时字幕与本地转录互斥 | ⚠️ 待成片按序核对 |
| PRE-RISK-07 | 竖版安全框需重算 | ⚠️ 待竖版抽帧（预检只有 16x9 帧） |

---

## 8. **本会话无法验证项**（诚实清单，需外部手段或 Lead 书面接受风险）

1. 字幕**是否遮挡关键 UI**（标准 3.3）——空间语义判断，无替代手段。
2. 空状态 / `0` 计数 / 加载中 / 引导浮层 / 浏览器 UI 痕迹（标准 4.1–4.3、4.5、4.7）——无颜色签名，
   现仅有源数据推断与 OCR 正向扫描。
3. 细鼠标焦点框（标准 4.6）——低于颜色检测可靠门槛。
4. 「50% 缩放下可读」的观感（标准 3.4）——仅能给出字号/对比度数字。
5. 无爆音、音乐未盖旁白的**听感**（标准 6.6/6.7）——只有 `astats`/`loudnorm` 数值旁证。
6. 竖版 9x16 的目视项——同上，且需先有竖版成片。

**建议**（任一即可解除）：① 恢复 MiniMax 视觉额度或换用任一具备图像输入的模型；
② 由人类花 2 分钟看 `promo/qa/frames/<视频名>/` 的抽帧（我可生成接触表）；
③ Lead 书面接受上述残余风险并在 REPORT 中标注。

---

## 9. 交付物与命令速查

```bash
PY=/Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
cd "/Users/fangchen/Baidu/GitHub/Notes&ToDo"

# 规格 / faststart / 音频 / 抽帧 / 品牌色
$PY promo/qa/check_spec.py check promo/build/out/*.mp4 --every 5 --shots -v
# 音画同步（字幕起点 vs 成片中 VO 实测起点）
$PY promo/qa/check_spec.py sync --video promo/build/out/notestogo-promo-16x9.mp4
# 字幕文案 vs 契约 §3（补 verify_captions 抓不到的一环）
$PY promo/qa/check_spec.py caps --timeline promo/build/timeline.json --layout 16x9
# 渲染脚本参数（CRF / profile / faststart）
$PY promo/qa/check_spec.py renderflags promo/build/render.sh
# 字幕像素同一性（Lead 的硬手段；注意 timeline 与 layout 必须配对）
$PY promo/build/tools/verify_captions.py --frames promo/build/_tmp/preview \
      --timeline promo/qa/_probe/timeline-16x9.json --layout 16x9
# 非目视帧取证（颜色签名 + 字幕安全框）
$PY promo/qa/check_frames.py "promo/build/_tmp/preview/SH-*.png" --layout 16x9
# 重生成某 layout 的时间轴到 QA 目录（不碰 Lead 的 timeline.json）
$PY promo/qa/probe_timeline.py --layout 16x9 --target 90
# 工具自检
$PY promo/qa/check_spec.py selftest
```

产物：`promo/qa/results/*.json`（机读证据）、`promo/qa/frames/<视频名>/`（抽帧 + INDEX）、
`promo/qa/_probe/`（重生成的时间轴与快照）。

---

## 10. 第 2 轮复核记录（Lead 修复后 · 重渲前）

### 10.1 已确认的修复
| 问题 | 复核方式 | 结果 |
|---|---|---|
| **成片无旁白**（致命） | 读 `render.py:504-514` 确认已加 `[vobus]asplit=2[sc0][vt0]` + 两条支路各 `apad` + `amix:duration=first`；并加 `ncc_with()` 内容自检（`ncc<0.5` → `SystemExit`） | ✅ 修复已落地，待重渲后实测 |
| **帧数被 `-shortest` 削掉** | `render.py:388,415` 已改为严格写 `round(total*FPS)` 帧（16:9=2700、9:16=1844） | ✅ 修复已落地 |
| 4/10 字幕与契约漂移 | `check_spec.py caps` | ✅ **10/10 一致（PASS 3/0/0）** |
| 契约 VO vs `vo-manifest.json` | 归一化逐条比对 | ✅ **10/10 完全一致**（长度亦一致，无截断） |

### 10.2 新增可执行证据（替代"目视"，覆盖标准 3 与部分 5；**不覆盖标准 4**）
| 证据 | 命令 | 结果 |
|---|---|---|
| 字幕像素同一性（**对解码后成片**） | `verify_captions.py --video out/notestogo-promo-16x9.mp4` | 16:9 **10/10**，实心笔画不一致率全 **0.0000** ⇒ 屏上文字与源码文案逐像素一致，可判**无错别字、无串行** |
| 竖版同上 | `verify_captions.py --layout 9x16 …` | Lead 报 9:16 **6/6**（待重渲后我复测） |
| 版面几何 | `check_frames.py` | 字幕底边距 83–88px、左边距最小 509px（口径见 §4 争议） |
| SH-09 设备落位断言 | 对账 `assets/brand/MANIFEST.json` | ✅ `device_then [340,112,412,856]` / `[932,114,648,852]`、phone `screen_rect_then [356,128,380,824]` **与品牌清单逐项一致** |

> ⚠️ **边界声明**：上表"像素同一性"是**渲染无损**证据 + 与源码一致性；它
> **不能**证明"画面里没有空状态/0 计数/加载中/浮层"（标准 4 的核心）。
> 标准 4 仍为 **🟡 受限证据 / 未目视确认**，不因本轮补证而升级为 PASS。

### 10.3 已知编辑处理（**披露项，不计为缺陷，也不计为默认**）
**SH-03 使用隐藏了「浏览器中只能录制麦克风」提示条的干净素材**（`*-clean.webm`）。
我的独立复核：
- 文案真值：`RecordingBar.tsx:120`「浏览器中只能录制麦克风；系统声音需 NotesToGO 桌面版，并在…」
- OCR 差分（`ocr.py`）：原版 `record-start.webm` / `live-meeting.png` **命中**该文案；`-clean` 版 **0 命中**
- 像素差分（定位到顶部条带 y 0–69）：提示条区 **79.71%** 像素被改写，画面其余部分仅 12.51%
  （后者是实时字幕随时间的正常差异，故不能用整帧差分判断）
- **结论**：该提示条确被移除；Lead 已声明属编辑决定、`render.py --banner` 可一键切回、并会写入交付说明。
  **记录为"已知编辑处理"**——真实 UI 中存在此提示，观众看不到它属于对产品真实状态的**选择性呈现**，
  不构成事实错误（提示只描述浏览器能力限制，桌面版可录系统声音），但审计上必须留痕。

### 10.4 本轮新发现的**小缺口**（建议 Lead 顺手修）
`render.py:549-554` 的内容自检里，**位置偏差只会打印 `⚠ 位置偏差`，不会 `SystemExit`**：
```python
if ncc < 0.5:  raise SystemExit(...)                      # ← 只有"存在性"是致命的
print(f"... {'✅' if abs(at - sh['start'] - VO_LEAD) < 0.5 else '⚠ 位置偏差'}")
```
⇒ 若 10 条旁白都在但整体错位 >0.5s，构建**仍会成功**，而音画同步正是标准 6 的核心。
**建议**：把位置偏差也纳入致命判定（或至少让它在退出码/汇总里可见）。
另：Lead 口头描述为"ncc<0.5 **或位置偏离 >0.5s** 就 SystemExit"，与代码实际不符（仅前者致命）——
按代码为准。

