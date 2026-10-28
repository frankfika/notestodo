# promo/capture —— 素材采集（负责人：capture）

真实产品 UI 的静帧与录屏。**全部由本机 Playwright + Chromium 跑真实应用采集**，
没有调用任何视频生成模型或云端 TTS。

## 一条命令重跑

```bash
# 1) 先起 dev server（必须用 dev，不要用陈旧的 web/dist）
cd web && pnpm dev --port 5173 --strictPort     # 另开一个终端

# 2) 回仓库根目录，重跑全部采集 + 清单 + 自检
cd .. && node promo/scripts/capture/run-all.mjs
```

只想重跑某几项：

```bash
node promo/scripts/capture/capture-stills.mjs today board      # 指定静帧
node promo/scripts/capture/capture-clips.mjs polish report     # 指定录屏
node promo/scripts/capture/build-manifest.mjs                  # 只重建 MANIFEST
python3 promo/scripts/capture/verify-frames.py                 # 只跑帧自检
```

有用的环境变量：

| 变量 | 作用 |
| --- | --- |
| `SHIBEI_URL` | dev server 地址，默认 `http://127.0.0.1:5173/` |
| `HIDE_CAPTURE_BANNER=1` | 隐藏录音时那条「系统声音需 NotesToGO 桌面版」提示条 |
| `CAPTURE_SUFFIX=-clean` | 给输出文件名加后缀（配合上一项产出 `*-clean` 素材） |
| `PYTHON` | 跑 `verify-frames.py` 的解释器（需 Pillow + numpy） |
| `FFPROBE` / `FFMPEG` | 默认 `/opt/homebrew/bin/` |

## 产出

```
capture/
├── MANIFEST.json           # w/h/duration_s 全部 ffprobe 实测（契约 §4.1）
├── seed/*.json             # 灌进 IndexedDB 的富数据存档 + polish 用 LLM 返回体
├── stills/*.png            # 17 张静帧（含 live-meeting-clean、ipad-portrait）
└── clips/*.webm            # 12 条录屏（含 record-start-clean、live-caption-clean）
```

| 类型 | 尺寸 |
| --- | --- |
| 桌面静帧 | viewport 1920×1080 · `deviceScaleFactor 2` → **3840×2160**（16:9，供 Ken Burns 裁切）|
| 移动静帧 | viewport 390×844 · `deviceScaleFactor 3` → **1170×2532** |
| iPad 横版 | viewport 1366×1024 · `deviceScaleFactor 2` → **2732×2048** |
| iPad 竖版 | viewport 768×1024 · `deviceScaleFactor 2` → **1536×2048**（3:4，合 `tablet-frame` 内屏 612×816）|
| 录屏 | viewport 1920×1080 · `deviceScaleFactor 1` · `recordVideo.size 1920×1080` · 每条 4.8–8.5s |

**iPad 竖版为什么拍「任务 · 今日焦点」而不是看板**：看板四列是 `min-w-[240px]`，
768px 视口下侧栏（`md:` 断点起显示）占 208px，只剩 560px → 只看得见约两列且要横向滚。
所以竖版选内容完整不塌的任务页。横版（`ipad-board.png`）看板四列同屏，保留。

## 目录里有什么

- `lib/seed.mjs` —— 富种子构造：4 场已整理会议（转录 / 纪要 / 速记 / 待办）+ 2 场待开会议、
  嵌套 OKR 树（战略 O → KR → 季度 O → 项目 KR → Task）、看板四列、知识库条目、模板、设置。
  字段严格照 `web/src/types.ts`。
- `lib/harness.mjs` —— Chromium 启动参数、播种、导航、截图、录屏、清场自检。
- `lib/fake-mic.mjs` —— 现场合成「类人声」假麦克风 WAV，让录音电平条全程可见。
- `capture-stills.mjs` / `capture-clips.mjs` / `build-manifest.mjs` / `run-all.mjs`。
- `verify-frames.py` —— 确定性帧自检（尺寸 / 非空白 / 正文墨色 / 首帧 UI / 尾部静置 / 中段动作）。

## 复用的既有写法（没有另发明一套）

- 播种：页面内 `await import('/src/db/db.ts')` 直接写 Dexie，搬自 `web/tests/okr-tree-ux.spec.ts`。
- 假麦克风：`--use-fake-device-for-media-stream` / `--use-fake-ui-for-media-stream`，见 `web/tests/recording.spec.ts`。
- 导航：`window.__uiStore`（`web/src/state/ui.ts` 里的 DEV 钩子）。
- 拖拽：直接派发 `DragEvent`，沿用 `web/tests/okr-tree-ux.spec.ts` 的结论
  （Playwright 真实鼠标拖拽在同一页第二次会挂住，与应用无关）。
- 关引导：`db.kv['onboarding_done_v1'] = true`（等价于点面板上的 ✕）。

## 必须知道的 5 条披露（成片/交付说明请一并带上）

1. **实时字幕的文案来自脚本，不是真识别结果。** 无头 Chromium 没有可用的中文识别后端，
   采集环境注入 `window.SpeechRecognition` 桩喂 `onresult`，但驱动的是产品**真实**的
   `web/src/lib/liveCaption.ts` 路径（`useCaption` store、`kv['live_caption_<id>']` 落库、
   面板累积滚屏、on/blocked/unsupported 状态机）。字幕文本本身是脚本内容。
2. **假麦克风不是真的在说话。** `lib/fake-mic.mjs` 合成的类人声信号经
   `--use-file-for-fake-audio-capture` 喂给 `getUserMedia`。Chromium 自带的假设备只在开头
   约 3 秒有声，会让电平条趴平、逼近会中页的静音提示阈值，故弃用。
3. **「重新整理」的 LLM 调用换成本地确定性响应。** 本机没有云端 Key，`polish` 片段拦截
   `POST /chat/completions` 返回 `seed/polish-llm-response.json`；跑的是真实
   `web/src/pipeline/summarize.ts`（含旧 `pending_review` 待办清理与重建、标题回写、原文引用定位）。
4. **浏览器能力提示条**：录音时产品会如实显示「浏览器中只能录制麦克风；系统声音需 NotesToGO
   桌面版…」。默认素材**保留**它（不假装成功）；`*-clean` 素材用 `HIDE_CAPTURE_BANNER=1`
   产出，供 SH-03 成片按需选用（桌面版是能录系统声音的，成片用干净版不会造成虚假宣称）。
5. **设置页不假装浏览器能离线推理。** `settings-ai.png` 里「本机内置」如实置灰，保留
   「需要 macOS 桌面版（浏览器无法运行内置模型）」；「数据去向」卡用真实的回环地址配置
   （自建本地服务 `127.0.0.1`）呈现产品原文「✓ 会议内容全部留在本机」。**没有**用 DEV mock
   伪造下载进度。

此外：DB 里已置 `onboarding_done_v1 = true`，并在采集时按掉 Onboarding 首帧渲染竞态
（`lib/harness.mjs` 的 `ONBOARDING_GUARD`），保证画面里不出现引导浮层。

## 清场自检

`capture-*.mjs` 对每张静帧、每条录屏的收尾帧做 **DOM 断言**（`assertClean()`）：禁用
空状态文案、`0` 计数、loading、报错、引导浮层；`-clean` 素材额外禁用能力提示条。
断言失败即记为 ✗，不会产出“看起来没问题”的坏素材。

`verify-frames.py` 再做一遍**像素级**自检：尺寸与 MANIFEST 一致、非空白帧、存在正文墨色、
录屏首帧 ≤0.35s 出现真实 UI、尾部静置 ≥0.8s、中段有可见变化。

> 本轮 MiniMax 视觉复核（`understand_image`）配额用尽、Gemini/Codex 通道也不可用，
> 因此逐帧人工目视复核改由上述两组确定性检查 + Lead 抽检承担；静帧内容为真实产品渲染，
> 未做任何贴字或改文案。
