# NotesToGO（拾贝）宣传片 · 交付说明

> 用**代码**做的宣传片：Playwright 采集真实 UI → Pillow 逐帧排版合成 → ffmpeg 编码。
> **全程没有调用任何视频生成模型**（无 Sora / Veo / Kling / Runway / 即梦），也没有用任何云端 TTS。

---

## 1. 成片（打开即用）

| 交付物 | 路径 | 规格 | 时长 |
|---|---|---|---|
| **主片 16:9** | [promo/build/out/notestogo-promo-16x9.mp4](promo/build/out/notestogo-promo-16x9.mp4) | 1920×1080 · 30fps · H.264 High · AAC 192k · 21.8MB | **90.000s** |
| **竖版 9:16** | [promo/build/out/notestogo-promo-9x16.mp4](promo/build/out/notestogo-promo-9x16.mp4) | 1080×1920 · 30fps · 7.3MB | **61.467s** |
| **无旁白版** | [promo/build/out/notestogo-promo-16x9-novo.mp4](promo/build/out/notestogo-promo-16x9-novo.mp4) | 同主片画面，音轨仅配乐 | **90.000s** |
| **封面** | [promo/build/out/cover-16x9.png](promo/build/out/cover-16x9.png) | 1920×1080，已装入真实产品截图 | — |
| 封面（纯排版） | [promo/build/out/cover-16x9-plain.png](promo/build/out/cover-16x9-plain.png) | 1920×1080，右侧留白面板 | — |
| 中文字幕 | [promo/script/subtitles-zh.srt](promo/script/subtitles-zh.srt) | 10 条，与烧入字幕逐字一致 | — |
| 英文字幕 | [promo/script/subtitles-en.srt](promo/script/subtitles-en.srt) | 10 条，人工撰写、非机翻 | — |

三个 mp4 都是 **faststart**（`ftyp→moov` 在最前），可直接上传 B 站/公众号/YouTube 而不必等整段缓冲。

**该给谁用哪一版**：横屏平台用 16:9；抖音/小红书/视频号/Reels/Shorts 用 9:16；需要自己配音或投放到静音信息流的场景用无旁白版（字幕已烧入画面，静音也能看懂）。9:16 不是把 16:9 压缩，而是**重新剪的 6 格片子**（钩子 → 开录/字幕 → 一次成稿 → 嵌套 OKR → 本地优先 → 收尾），每格旁白完整。

---

## 2. 实测指标（都是跑出来的数字，不是估算）

| 指标 | 16:9 | 9:16 | 无旁白版 | 判定 |
|---|---|---|---|---|
| 画面 | 1920×1080 H.264 High yuv420p 30fps · **2700 帧** | 1080×1920 · **1844 帧** | 1920×1080 · 2700 帧 | ✅ |
| 时长 | **90.000000s** | **61.466667s** | 90.000000s | ✅ 90±3 / 60±3 |
| 响度（EBU R128） | **−16.0 LUFS** | −16.0 LUFS | −18.0 LUFS | ✅ |
| 真峰值 | **−1.5 dBTP** | −1.5 dBTP | −8.0 dBTP | ✅ 媒体平台安全线内 |
| 音画同步 | 10/10 条旁白，位置偏差 **0ms** | 6/6 条，0ms | 仅配乐（设计如此） | ✅ |
| 字幕像素同一性 | **10/10**（笔画不一致率 0.0000） | **6/6** | 10/10 | ✅ 屏上文字与源码逐像素一致 |

**关键点**：旁白是用**内容级**方法验证的——不是"文件里有声音"就算过，而是对成品音轨做 FFT 滑窗互相关，逐条确认每条旁白**确实在**、且**落在预期的时间点上**（阈值 0.10s，不达标直接构建失败）。这一层的存在是有教训的，见 §6。

---

## 3. 一分钟重建

```bash
PY=/Users/fangchen/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3   # 本机自带 Pillow/numpy 的 Python

# 只算时间轴，看每格时长（不渲染）
$PY promo/build/render.py --dry-run

# 预览：每格抽一帧（含字幕叠加），2 分钟出图，用来快速看排版
$PY promo/build/render.py --preview

# 出成片
$PY promo/build/render.py --layout 16x9 --preset medium    # 主片
$PY promo/build/render.py --layout 9x16 --preset medium     # 竖版
$PY promo/build/tools/make_novo.py                          # 无旁白版（复用主片画面流）

# 验收
$PY promo/build/tools/verify_captions.py --video promo/build/out/notestogo-promo-16x9.mp4
$PY promo/build/tools/verify_captions.py --video promo/build/out/notestogo-promo-9x16.mp4 --layout 9x16
```

采集端（要重出素材时）：见 [promo/capture/README.md](promo/capture/README.md) 与 [promo/scripts/](promo/scripts/)。
旁白/配乐重出：见 [promo/audio/README.md](promo/audio/README.md) 与 [promo/script/vo.md](promo/script/vo.md)。

**依赖**：ffmpeg/ffprobe 8.0.1、Pillow 12.3、numpy 2.3、Playwright（chromium）、tesseract 5.5（仅验收用）、macOS `say`（旁白）。全部已在本机装好。

---

## 4. 技术路线，以及我为什么没选别的

### 实际复用的成熟项目（没有重造轮子）

| 用途 | 项目 | 许可证 |
|---|---|---|
| 解码录屏、编码 H.264、封装、响度/峰值测量 | **FFmpeg 8.0.1** | LGPL/GPL（本机为 `--enable-gpl --enable-libx264` 构建） |
| 逐帧排版合成（Ken Burns／转场／字幕卡／机身框／投影） | **Pillow 12.3** | MIT-CMU |
| 配乐合成、像素级比对、音频互相关 | **NumPy 2.3** | BSD-3-Clause |
| 真实 UI 采集（静帧 + 录屏） | **Playwright** (Chromium) | Apache-2.0 |
| 验收期 OCR 冒烟 | **tesseract 5.5.2**（`chi_sim`） | Apache-2.0 |
| 旁白 TTS（本机离线） | macOS `say`（Shelley zh_CN） | 系统组件 |
| 中文字体 | **Noto Sans SC**（本机 `~/Library/Fonts/`） | SIL OFL 1.1 |

> 关于 FFmpeg 的 GPL：我是把它当**独立可执行程序**调用的（不经库链接），因此本项目自身代码不因 GPL 被传染；而用 x264 编出来的**视频成品本身**不受 GPL 约束。若你要对外分发 ffmpeg 二进制才需要遵守 GPL。

自写的只有编排／排版／混音／验收这几层，共约 **1800 行 Python**（`promo/build/`）——编解码、渲染、TTS、OCR、浏览器自动化全部用现成的。

### 没选的路子与理由

- **ffmpeg `zoompan` 做 Ken Burns**（官方现成滤镜）：被否。同类的时间变参 `crop` 表达式在本机 ffmpeg 8.0.1 上**在 filter init 阶段就报错**（`Error when evaluating the expression 'floor(ih/(1+0.06*t/5)/2)*2'`）；而 `zoompan` 有已知的平移抖动与整数像素取整问题。改成 Pillow 逐帧重采样后，缩放插值可按倍率分级（比例 >1.25 用 BOX、否则 BILINEAR），且品牌卡片本来就是 Pillow 画的，同一套代码可复用。
- **Remotion**（React 写视频，业界最主流的"代码化视频"方案）：未采用。它需要引入 Node 侧渲染管线再挂一个 Chromium；且 Remotion 采用自有许可（Remotion License），公司规模超过阈值需购买商业授权。**我必须说明：本会话收尾阶段联网检索通道失效（见 §6），我无法在交付时复核它的当前条款与阈值**，所以这里的理由只按工程成本计，不作为法律结论——如果你打算走这条路，请自行核对许可证。
- **Motion Canvas**（MIT）：未采用。它面向矢量动画/解释性视频，与"真实产品截图逐帧合成 + 品牌排版"的需求不同构。
- **editly**（MIT，声明式 ffmpeg 剪辑）：未采用。静态图的逐帧 Ken Burns 仍要自己写；且其活跃度我同样**未能联网复核**。
- **Screen Studio / Kap 等录屏工具**：不需要。素材已经由 Playwright 采到了，缺的是合成而不是录制。

---

## 5. 我在片子里做的编辑决定（如实披露）

1. **SH-03（录音镜头）用的是隐藏了"浏览器能力提示条"的干净素材。**
   真实 UI 顶部有一条提示：「浏览器中只能录制麦克风；系统声音需 NotesToGO 桌面版，并在「系统设置 → 隐私与安全性 → 屏幕录制」中授权。」
   我把它在成片里隐去了。理由：这条只描述**浏览器**的能力限制，而宣传片代表的是**包含 macOS 桌面版在内的完整产品**（桌面版本就能录系统声音）；留着反而会让观众误以为产品录不了系统声音。该镜头讲的是"速记 + 实时字幕"，不涉及系统音频，所以隐去它**不构成任何虚假宣称**。
   证据与痕迹：原版静帧 OCR 命中该文案、`-clean` 版 0 命中；原始素材 `live-meeting.png` / `record-start.webm` / `live-caption.webm` **都保留着**，随时可对照。想换成带提示条的版本：`render.py --banner`。
2. **实时字幕的中文识别文本是脚本化的。** 采集环境（headless Chromium）没有中文 ASR 后端，所以会中那条"实时字幕"是用脚本化的 `onresult` 事件驱动真实代码路径 `web/src/lib/liveCaption.ts` 产生的。详见 [promo/capture/README.md](promo/capture/README.md)。
3. **SH-08「数据去向」展示的是浏览器里的真实状态**，不是伪造的桌面版画面：置灰的「本机内置」保留了原文「需要 macOS 桌面版（浏览器无法运行内置模型）」，选中"自建本地服务"并显示回环地址，数据流向徽标是真实的 `✓ 会议内容全部留在本机`。字幕也相应写成「**桌面版**内置模型 · 断网可用 · 数据去向如实自检」，没有暗示网页版能离线推理。
4. **旁白用本机 `say` 合成**（嗓音 Shelley zh_CN，全片单一嗓音），配乐是用 numpy 从零合成的（Cmaj7–Am7–Fmaj7–G6，66BPM），**零版权风险**，可商用。
5. **9:16 是重新剪的分镜子集**，不是把 16:9 压缩——旁白一句话都没被截断。
6. **字幕领先人声 80ms 出现**（不是对齐到 0ms）：听感上更自然，且远小于 300ms 的可感知错位阈值。

---

## 6. 已知限制（以及我踩过的两个坑）

### 限制

- **本会话没有任何视觉通道**：云端视觉工具额度耗尽、`read_image` 被模型拒绝、两条替代视觉子代理实测均无法看图。因此**"画面里是否出现空状态 / 0 计数 / 加载中 / 报错 toast / 引导浮层"这一项我没有做逐帧目视确认**，只能依赖：① 采集端对每张素材的自检与披露；② 我用代码做的版面几何断言。验收方（[promo/qa/REPORT.md](promo/qa/REPORT.md)）据此把这一项标为**"无法验证"而非 PASS**——我认可这个判断，不为凑通过而放宽。
- **OCR 只能用来做"存在性/位置"冒烟**：tesseract 对 36px 中文实测约 8 成字符正确（「关键词」会认成「天键词」），它出过假 MISS。**逐字正确性改用"字幕像素同一性"证明**（把成片同一位置的字幕与按源码文案重画的结果逐像素比对，只在完全不透明的实心笔画像素上判定）。
- **联网检索通道在收尾阶段失效**（`web_search` 返回 401、MiniMax 额度用尽），所以 §4 的"现成方案调研"**没能在交付前补做完整**，相关许可证与活跃度请以你自行复核为准。
- 9:16 时长 **61.467s**，超出 60s 目标 1.467s——**仍在 60±3s 容差内**。若需要严格 ≤60s，最小改动是收紧两处转场（`SHOTS[*].xfade`）。
- 无旁白版是**复用主片视频流**（`-c:v copy`）换音轨得到的，画面与主片比特级一致，因此它**不带英文字幕**（若要英文字幕版需单独烧入）。

### 两个坑（写在这里，免得后人再踩）

1. **ffmpeg 会静默丢东西。** 混音图里 `[vobus]` 同时被 `sidechaincompress` 和最终 `amix` 引用，却漏了 `asplit=2` —— ffmpeg 8.0.1 **返回码 0、不报任何错**，直接把第二个消费者丢掉。结果：三个成片全都没有旁白，只剩配乐。
   **最危险的连锁反应**：因为 `loudnorm` 把纯音乐也拉到了目标值，**响度 −16.0 LUFS ✅、真峰值 −5.5 dBTP ✅、faststart ✅、字幕像素同一性 10/10 ✅ —— 所有"规格类"检查全部漂亮通过**。规格检查查不出"内容没了"。
   是独立验收方用互相关定位旁白才抓出来的。现在 `build_mix()` 内置了内容+时序双自检（旁白缺一条、或整体错位 >0.10s 都直接构建失败）。
2. **`sidechaincompress` 的输出长度取决于侧链。** 侧链（旁白总线）在最后一句就结束了，于是整条音轨被截短到 89.777s，封装时 `-shortest` **连画面一起剪掉 11 帧**（竖版少了 2 帧）。修法：侧链与旁白支路各自 `apad` 补零、`amix` 用 `duration=first`、混音故意比时间轴多留 0.5s 让**视频流**决定收尾，同时编码端严格只写 `round(total×FPS)` 帧。

---

## 7. 顺手发现的产品缺陷（**我没有改，等你决定**）

采集过程中发现 [web/src/pages/today/TodayPage.tsx](web/src/pages/today/TodayPage.tsx) 里：

```ts
fmtDateTime(ev.start).slice(6)
```

`fmtDateTime` 对"今天/昨天/明天"返回的是 2 个字的相对日期（如「今天」），`slice(6)` 会把整个字符串切掉，只剩下一段**孤零零的分钟数**显示在会议卡上。采集端因此把演示会议放到了 2/4 天之后来绕开它。

这是真实 UI 缺陷，**不属于宣传片范围，我没有动产品代码**。要不要修由你决定。

---

## 8. 文件地图

```
promo/
├─ README.md                  ← 本文件
├─ STORYBOARD.md              分镜契约（10 格：画面/旁白/字幕/素材），已与实现同步
├─ build/
│  ├─ render.py               渲染主程序：时间轴 → 逐帧合成 → 编码 → 混音 → 封装 → SRT
│  ├─ video.py                合成库：版式、设备机身框、Ken Burns、转场、字幕卡、水印
│  ├─ timeline.json           时间轴（16:9 主片；各画幅另有 timeline-<layout>.json）
│  ├─ out/                    ★ 成片与封面
│  └─ tools/                  自写小工具：字幕像素校验 / 本地 OCR / 封面 / 无旁白版 / 重混音
├─ capture/                   采集端：19 张静帧 + 10 条录屏 + 3 条干净版 + MANIFEST + README
├─ assets/brand/              品牌资产：标题卡/尾卡/封面/要点条/机身框/hook 大字 + MANIFEST
├─ audio/                     旁白 10 条 + numpy 自研配乐 + 预览混音 + 说明
├─ script/                    中英字幕 SRT + 旁白文案与选型记录
├─ qa/                        独立验收：CHECKLIST / REPORT / check_spec 等
└─ scripts/                   采集与音频的可复跑脚本
```

---

## 9. 验收

- **最终验收报告**：[promo/qa/REPORT-FINAL.md](promo/qa/REPORT-FINAL.md)（v3 终版：7 条标准 6 条 PASS、1 条"无法验证"，含每个 FAIL 的修法、每条证据的可复算命令）
- **历史审计痕迹**：[promo/qa/REPORT.md](promo/qa/REPORT.md)（v1/v2 旧版，含 asplit 致命 bug 的发现与修复过程）
- **验收清单**：[promo/qa/CHECKLIST.md](promo/qa/CHECKLIST.md)
- **我自己跑的关键证据**：§2 的指标表 + `promo/build/tools/verify_captions.py` 的字幕像素校验 + `build_mix()` 的旁白内容/时序自检。

> 诚实说明：本片的**画面**（排版、动效、字幕、设备框）由我用数值与几何方法验证；**声音**由独立的互相关定位验证；**画面内容本身是否恰当**（有没有不该出现的东西）在本会话缺乏视觉通道的前提下**没有被逐帧目视确认**。如果你或同事在播放时看到任何不对的画面，请直接告诉我具体时间点，我按时间轴定位到那一格修改重出。
