# NotesToGO 宣传片 · 独立验收 REPORT

**验收人**：`verify`（QA，独立复核；写作用域 `promo/qa/**`，未改动他人任何产物）
**依据**：`promo/STORYBOARD.md` §5 七条验收标准
**被验对象**（本轮唯一有效版本）：

| 文件 | 时长 | sha256 / 备注 |
|---|---|---|
| `promo/build/out/notestogo-promo-16x9.mp4` | 90.000s | `34501675df7d1d83bfe504048b946e968dc9ec239decc01874d1363fc18f3bc0` (19:47:13, 21,598,964 B) |
| `promo/build/out/notestogo-promo-9x16.mp4` | 61.452s | 竖版，19:48 |
| `promo/build/out/notestogo-promo-16x9-novo.mp4` | 89.967s | 无旁白版（纯音乐为其**预期**行为） |

稳定性已确认（间隔 3s 两次 stat 大小/mtime 一致，非写入中）。

---

## 结论摘要

| # | 验收标准 | 判定 | 一句话 |
|---|---|---|---|
| 1 | 时长与规格 | ✅ **PASS** | 全部 8 项实测达标，主片 90.000s 整 |
| 2 | 可拖动（faststart） | ✅ **PASS** | `ftyp→moov→free→mdat`，moov@32B |
| 3 | 字幕 | ⚠️ **部分 PASS + 1 FAIL** | 像素同一性 10/10 ✅；但与契约 §3 有 4 条漂移 ❌；遮挡关键 UI **无法验证** |
| 4 | 画面禁止出现 | ❓ **无法验证** | 无视觉通道；仅有间接证据与颜色签名阴性 |
| 5 | 品牌一致 | ✅ **PASS** | 品牌橘 27/27 帧检出，字体/emoji 源码级达标 |
| 6 | 音画同步 / 无爆音 | ❌ **FAIL（致命）** | **三个成片完全没有旁白**，音轨 = 纯音乐 |
| 7 | 事实准确 | ✅ **PASS**（附 3 条待联网核） | 23 条宣称全部有出处；另 4 条契约漂移需收敛 |

### 总裁定：**不通过**（2 项 FAIL、1 项无法验证）

阻断发布的是 **标准 6**：成片没有旁白。画面、字幕、规格、响度都好，唯独**没人说话**。

---

## ❌ 标准 6 · 致命问题：成片无旁白

### 现象
三个 mp4 的音轨与 `promo/audio/music/bed.wav`（纯音乐）波形几乎完全一致：
`film vs bed ncc = +0.9992`；与 `audio/mix/master.wav`（含旁白）仅 `+0.1561`。
10 条 VO 在整个成片里均定位不到（最佳 ncc≈0.03 = 不存在）。

### 原始命令 + 输出
```bash
$PY - <<'EOF'
import sys, numpy as np; sys.path.insert(0,'promo/qa')
from check_spec import decode_pcm_mono16k, locate_vo
bed=decode_pcm_mono16k('promo/audio/music/bed.wav')
vo01=decode_pcm_mono16k('promo/audio/vo/vo-01.wav')
for f in ('notestogo-promo-16x9','notestogo-promo-9x16','notestogo-promo-16x9-novo'):
    a=decode_pcm_mono16k(f'promo/build/out/{f}.mp4'); n=min(len(a),len(bed))
    ncc=float((a[:n]*bed[:n]).sum()/np.sqrt((a[:n]**2).sum()*(bed[:n]**2).sum()))
    print(f, 'vs bed ncc=%.4f'%ncc, 'vo-01 ncc=%.4f'%locate_vo(a,vo01)['ncc'])
EOF
```
```
notestogo-promo-16x9.mp4       vs bed ncc=+0.9992   vo-01 ncc=0.0430   ❌无旁白
notestogo-promo-9x16.mp4       vs bed ncc=+0.9992   vo-01 ncc=0.0432   ❌无旁白
notestogo-promo-16x9-novo.mp4  vs bed ncc=+1.0000   vo-01 ncc=0.0439   ❌（novo 属预期）
参照：vo-01 在 audio/mix/master.wav 中 ncc=0.9914  ⇒ **素材本身是好的**
中间产物：promo/build/_tmp/mix-16x9.wav  vo-01 ncc=0.0429  ⇒ 根因在 build_mix
```
旁证：成片每秒 RMS 极其平坦（全程 -12 ~ -16 dBFS，无语音停顿起伏），与"纯音乐"一致。

### 根因（已逐变体复现，**rc 均为 0，不报错**）
`promo/build/render.py:495-499` 的 `[vobus]` 同时被 `sidechaincompress` 与最后的 `amix` 消费，
**缺 `asplit`**；ffmpeg 8.0.1 **静默丢弃第二个消费者**，最终 `amix` 只拿到 `[bedduck]`：
```
变体C（现行写法）  vo-01 ncc=0.0429  ❌ 旁白被吞
变体A（去掉 sidechain） vo-01 ncc=0.9380  ✅
变体B（加 asplit=2）   vo-01 ncc=0.9813  ✅  ← 正确修法
```
**建议修法**：
```python
filters.append("[vobus]asplit=2[sc][vt]")
filters.append("[bed][sc]sidechaincompress=threshold=0.035:ratio=6:attack=25:release=420:makeup=1[bedduck]")
filters.append("[bedduck][vt]amix=inputs=2:normalize=0[mixed]")
```
**并请加落盘自检**（本次正是它漏掉的）：
```python
from ... import locate_vo   # 或直接复用 QA 的探测
assert locate_vo(decode_pcm_mono16k(raw), decode_pcm_mono16k(AUDIO/"vo"/"vo-01.wav"))["ncc"] > 0.5
```

### ⚠️ 教训：响度检查是"假通过"
因 loudnorm 把**纯音乐**拉到目标值，本级 `S1.8` 报 `-16.01 LUFS` ✅、`S6.1` 报 `-5.56 dBTP` ✅——
**规格/响度检查无法发现内容缺失**。今后音频验收必须加"旁白存在性"这一项（本轮已补）。

### 其余音频项（在"有音频"前提下有效）
| 检查 | 实测 | 期望 | 判定 |
|---|---|---|---|
| S6.1 真峰值 | -5.56 dBTP（loudnorm）/ -5.60（ebur128） | < -1.0 dBTP | ✅ |
| S1.8 整合响度 | -16.01 LUFS（ebur128 -16.0） | -16 ±2 LU | ✅（口径见下） |
| S6.3 削波 | `Peak count=2, Flat factor=0.000000` | 无削波 | ✅（数值口径：Flat factor≈0） |
| **S6.5 字幕↔人声同步** | **10/10 条 ncc<0.15，最大偏差 61460 ms** | 每条 <300 ms | ❌ **无法测**——因为无旁白，非剪辑错位 |

> `-16 LUFS` 容差为本人 `derived()`（契约 §1 只给目标值，未给容差）：±2 LU 记 PASS，超 ±3 LU 记 FAIL。
> `S6.5` 的 61.46s"偏差"是**工具在纯音乐里乱找**的结果（ncc 全 <0.15 已自行标注低置信度），
> **不能**据此说"剪辑不同步"；旁白修复后必须重测。

---

## ✅ 标准 1 · 时长与规格（PASS 11 / WARN 0 / FAIL 0）

```bash
$PY promo/qa/check_spec.py check promo/build/out/notestogo-promo-16x9.mp4 --every 5 --shots -v
```
| 检查 | 实测 | 期望 |
|---|---|---|
| S1.1 分辨率 | 1920x1080 | 1920x1080 ✅ |
| S1.2 帧率 | `r_frame_rate=30/1`，`avg_frame_rate=30/1`（相等 ⇒ 非 VFR） | 30 fps ✅ |
| S1.3 像素格式 | yuv420p | yuv420p ✅ |
| S1.4 视频编码 | h264 / profile=High | h264 / High ✅ |
| S1.5/S1.6 音频 | 存在；aac 48000Hz 2ch | ✅ |
| S1.7 时长 | **90.000s** | 90±3s ✅ |
| S3.0 抽帧 | 27/27 成功 → `promo/qa/frames/notestogo-promo-16x9/` | ✅ |

竖版：`1080x1920 / 30fps / yuv420p / 61.452s`（∈[57,63]）✅

## ✅ 标准 2 · faststart（PASS）
```bash
python3 -c "…top_level_boxes('promo/build/out/notestogo-promo-16x9.mp4')…"
```
实测顶层 box：`ftyp(0) → moov(32) → free(…) → mdat(99480)` ⇒ **moov 在 mdat 之前** ✅
（竖版、novo 版同样 ✅。纯 Python 解 box，不依赖 ffmpeg 自述。）
**遗留人工项**：`ffplay` 实际拖动到 30s/60s 各一次（我无 GUI，未做）。

## ⚠️ 标准 3 · 字幕

### 3.1a 像素同一性（✅ 10/10，**直接对成片抽帧**）
```bash
$PY promo/build/tools/verify_captions.py --video promo/build/out/notestogo-promo-16x9.mp4
```
```
SH-01 t= 3.35s OK 笔画不一致率=0.0000 平均差=2.0  字幕="开会时，你在讨论，还是在抄笔记？"
SH-02 t= 9.33s OK 笔画不一致率=0.0000 …          "NotesToGO 拾贝 · 会中只记关键词，散会后一键成稿"
SH-03 t=18.34s OK 笔画不一致率=0.0000 …          "⌘⇧R 一键开录 · 会中只记关键词，回车即存"
SH-04…SH-10 全部 OK 笔画不一致率=0.0000
字幕像素校验：10/10 通过
```
⇒ 编码后成片里每个字都画对了（含 `⌘⇧R` 正确）。**这是"渲染无损"证据，不是"文案正确"证据。**

### 3.1b 字幕文案 vs 契约 §3（❌ FAIL，6/10）
```bash
$PY promo/qa/check_spec.py caps --timeline promo/build/timeline.json --layout 16x9
```
```
❌ [FAIL] S7.3 字幕文案与契约逐字一致
   实测：6/10 一致；不一致 4 条: ['SH-02','SH-05','SH-07','SH-10']
```
| 分镜 | 契约 §3 | 成片实际 | 事实性 |
|---|---|---|---|
| SH-02 | `NotesToGO · 拾贝` | `NotesToGO 拾贝 · 会中只记关键词，散会后一键成稿` | ✅ 有出处 |
| SH-05 | `说话人 1 / 说话人 2 · 时间戳可跳转` | `转录带说话人区分 · 谁在什么时候说了什么` | ✅ 有出处（丢了"时间戳可跳转"，该能力真实存在） |
| SH-07 | `看板拖拽 · 自动周报 · 一键复制` | `看板拖拽换列 · 自动周报一键复制` | ✅ 有出处 |
| SH-10 | `github.com/frankfika/notestodo` | `github.com/frankfika/notestodo · 本地优先 · 开源` | ✅ 有出处 |

**均无事实错误**，属契约漂移。契约自称"文案以此为准"，故须由 Lead 收敛（最省事：改契约 §3）。

### 3.2 安全框（实测，口径待裁决）
27 帧中 25 帧含字幕，实心笔画边距实测：**底边距 83–88px**（83×4、87×10、88×11），**左边距最小 509px**。
- 按 5% 行动安全区（1080×5%=54px）→ ✅ 通过
- 按契约 §4.2 的 96px（**该值原文是为品牌素材规定的**）→ ❌ 10/10 不达标
契约未对烧入字幕规定数值 ⇒ **我不擅自判 FAIL**，请 Lead 明确一句口径。

### 3.3 字幕是否遮挡关键 UI → **❓ 无法验证**
空间语义判断，无替代手段（详见文末"无法验证项"）。

## ❓ 标准 4 · 画面禁止出现 → **只能给受限证据**

**结论：不能判 PASS。** 本轮所有可用手段均为"正向证据"，均未命中，但**未命中 ≠ 不存在**。

| 子项 | 手段 | 实测 | 可信度 |
|---|---|---|---|
| 4.4 报错 toast | 危险红 #B7493F 紧凑色块检测 | **0 条**（27 帧） | 弱正向 |
| 4.6 鼠标焦点框 | 饱和蓝检测 | **0 条**（27 帧，pct=0.0000） | 弱（细焦点框低于门槛） |
| 4.5 引导浮层 / 4.7 浏览器痕迹 | 无颜色签名 | **无法验证** | — |
| 4.1 空状态 | 间接：空状态由 `length===0` 守卫（`TodayPage.tsx:147`），而种子富足（`todos.json` 39、`meetings.json` 6、`notes.json` 7、`scribbles.json` 7） | 守卫应为假 | 间接推断 |
| 4.2 `0` 计数 | 同上 | 无法排除子计数器 | 间接推断 |
| 4.3 加载中 | 需排除 `MeetingDetailPage.tsx:267` 的 `AI 正在整理笔记…`（`inFlight\|\|polishing`） | 未目视确认 | 间接 |
| 4.8 OCR 危险词表 | `check_frames.py --ocr` 正向扫描 | 见下 | 弱正向 |

**OCR 已实测不可信**：对 SH-08 帧 `--expect "桌面版内置模型"` 返回 **MISS**，而同一处像素同一性为
**0.0000**（文案铁定正确）⇒ OCR 的"没找到"**绝不能**当 PASS 依据。

## ✅ 标准 5 · 品牌一致（PASS，观感项除外）
| 检查 | 实测 | 判定 |
|---|---|---|
| 品牌橘 `#C0571E` | **27/27 帧检出**，覆盖 0.443%–12.145% | ✅ |
| 纸色 `#FBF8F2` | 17.81%–81.80% | ✅ |
| 过期青蓝 `#24727A`（README:87） | 无**成片区域**出现（散点密度 0.007，非色块） | ✅ |
| 无 emoji | 全部上台文案无 emoji 码点（产品按 README:89 用文字符号） | ✅ 源码级 |
| 字体 | `video.py:43` NotoSansSC-Variable.ttf；`make_brand_assets.py:84-86` Noto/PingFang | ✅ 源码级 |
> 说明：颜色检测已加"区域密度 ≥0.25"门槛——初版用裸占比会被真实 UI 的抗锯齿散点**每帧假报警**
> （实测 bbox 覆盖 1920×960 但密度仅 0.007），该阈值是我校准后的结果，非契约值。

## ✅ 标准 7 · 事实准确（PASS）
`promo/qa/CHECKLIST.md` §6 共 **23 条**宣称，全部给出 README 行号或 `文件:行号`，
**无一条"无出处"**。3 条待联网复核（仓库 public 状态、URL 可达性）。
已核对的具体数字（SH-08）：Whisper Large v3 Turbo 574MB / Small 190MB（README:26 +
`builtinModels.ts:41,46` 的 `574_041_195`/`190_085_487`）、说话人区分约 30MB（README:27 + `builtinModels.ts:57`）。

---

## ❓ 无法验证项（诚实清单）
1. **字幕是否遮挡关键 UI**（标准 3.3）——空间语义，无替代手段。
2. 空状态 / `0` 计数 / 加载中 / 引导浮层 / 浏览器 UI 痕迹（4.1–4.3、4.5、4.7）——无颜色签名。
3. 细鼠标焦点框（4.6）——低于检测可靠门槛。
4. "50% 缩放下可读"的观感（3.4）——仅能给出字号/边距数字。
5. 无爆音、音乐未盖旁白的**听感**（6.6/6.7）——只有 `astats`/`loudnorm` 数值旁证。
6. 竖版全部目视项。
7. `ffplay` 实际拖动（2.2）。

**原因**：`mcp__MiniMax__understand_image` 额度耗尽；本会话模型不接受图像输入
（`read_image` 报 `does not declare image input`）；两条替代视觉通道实测均不可用
（`volces-ark/glm-5-3-flash-260828`、`minimax-cn/MiniMax-M3` 子代理均返回 `CANNOT_SEE`/失败）。
**解除方式**：① 恢复视觉额度或换具备图像输入的模型；② 人工看
`promo/qa/frames/notestogo-promo-16x9/`（27 张，含 10 个分镜中点位）；③ Lead 书面接受残余风险。

---

## 最小复现（FAIL 项）
**FAIL-1（标准 6，致命）· 成片无旁白**
- 时间点：全片（0s 起即无旁白）
- 命令：`ffprobe`/解码比对（见上）；一行版：
  `ffmpeg -i promo/build/out/notestogo-promo-16x9.mp4 -af astats -f null -` 配合 `vo-01` 互相关
- 期望：`locate_vo(成片, vo-01).ncc > 0.5`（应能定位到 0.4s 附近）
- 实际：`ncc = 0.0430`；成片 vs `bed.wav` `ncc = 0.9992`

**FAIL-2（标准 3.1b / 7.6）· 字幕与契约漂移**
- 命令：`$PY promo/qa/check_spec.py caps --timeline promo/build/timeline.json --layout 16x9`
- 期望：10/10 一致；实际：6/10，不一致 `SH-02、SH-05、SH-07、SH-10`

**FAIL-3（契约交付物）· `promo/capture/MANIFEST.json` 缺失**
- 命令：`ls promo/capture/MANIFEST.json` → `No such file or directory`
- 期望：契约 §4.1 要求存在（含每条静帧/录屏实测时长与内容）

---

## 证据文件
- 机读证据：`promo/qa/results/notestogo-promo-16x9.json`
- 抽帧：`promo/qa/frames/notestogo-promo-16x9/`（27 张，含 `INDEX.md`）
- 帧取证：`promo/qa/results/_frames_forensics.json`
- 工具：`promo/qa/check_spec.py`（含 `caps`/`sync`/`selftest`）、`promo/qa/check_frames.py`、`promo/qa/probe_timeline.py`
- 复核清单：`promo/qa/CHECKLIST.md`（v2，手段替换表 + 校准说明）

## 复审条件
修复 `build_mix` 旁白丢失并重渲后，我将重跑全部 7 条并更新本报告；
在旁白修复前，**标准 6 不会通过**，本报告结论保持"不通过"。

---

# 第 2 轮复核（Lead 修复后 · **重渲前**）

> 状态：**本报告总裁定仍为「不通过」**——重渲尚未完成，尚无新成片可供实测。
> 以下为"修复已落地"的**代码级与旁证级**复核，非成片验收。

## A. 修复确认（✅ 代码已落地）
| 问题 | 复核 | 结果 |
|---|---|---|
| 成片无旁白（致命） | `render.py:509-514`：`[vobus]asplit=2[sc0][vt0]` → 两支路各 `apad` → `sidechaincompress` → `amix:duration=first` | ✅ 与我实测的变体 B 修法一致 |
| 内容自检 | `render.py:546-553` `ncc_with()`（FFT 滑窗互相关） | ✅ `ncc<0.5` 即 `SystemExit` |
| 帧数被 `-shortest` 削掉 | `render.py:388,415` 严格写 `round(total*FPS)` 帧 | ✅ 不再依赖 `-shortest` 兜底 |
| 契约漂移 | `check_spec.py caps` | ✅ **10/10（PASS 3 · WARN 0 · FAIL 0）** |
| 契约 VO vs `vo-manifest` | 归一化后 10 条逐条比对 | ✅ **10/10 完全一致**（长度亦一致，无截断） |

## B. 独立复核了 Lead 的三项主张
1. **SH-09 设备落位**：对账 `assets/brand/MANIFEST.json` → `device_then [340,112,412,856]` /
   `[932,114,648,852]`、phone `screen_rect_then [356,128,380,824]` **逐项一致** ✅
2. **SH-03 提示条已移除**：OCR 差分——原版 `record-start.webm`/`live-meeting.png` **命中**
   「浏览器中只能录制麦克风」（真值见 `RecordingBar.tsx:120`），`-clean` 版 **0 命中**；
   像素差分定位顶部条带（y 0–69）**79.71%** 被改写（画面其余仅 12.51%，属实时字幕时间差）。
   注：整帧差分 13.96% 无法定位问题，必须按条带拆开看 ✅
   → 已按 Lead 要求记为**「已知编辑处理」**，不计缺陷、不计默认（见 CHECKLIST §10.3）
3. **VO/manifest 一致**：✅（见 A）

## C. 新发现的小缺口（建议修，非阻断）
`render.py:549-554`：内容自检中**只有 `ncc<0.5` 是致命的**；位置偏差仅打印 `⚠ 位置偏差`，
**不 `SystemExit`**。若 10 条旁白齐备但整体错位 >0.5s，构建**仍会成功**——而音画同步正是标准 6 的核心。
建议把位置偏差也纳入致命判定。（Lead 描述为"或位置偏离 >0.5s 就 SystemExit"，与代码实际不符，**以代码为准**。）

## D. 重渲后我将实测（**不预先写结论**）
标准 6 全量（`sync` 逐条偏差 + 与标称 −80ms 的偏离 + 真峰值 + 响度）、
**总时长是否回到 90.000s 且 `nb_frames=2700`**（验证帧数修复）、竖版 `nb_frames=1844` / 61.452s、
旁白存在性（`locate_vo` ncc>0.5 且命中位置符合预期）、
字幕像素同一性（16:9 10/10、9:16 6/6）、`caps` 10/10、标准 1/2/5 复测。
**标准 4 与"字幕遮挡关键 UI"仍将标注为无法验证**——不因本轮补证而放宽。

## E. 仍未闭环
- `promo/capture/MANIFEST.json` **仍缺失**（保持 FAIL，直到文件落地）。
- `timeline.json` / `subtitles-zh.srt` 按 layout 覆盖写的健壮性问题（CHECKLIST §5.3）未见改动。
