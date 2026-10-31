# NotesToGO · 会议速记 × Notion 式工作区

> 开会时只记关键词，散会后一键整理成笔记；行动项进任务树，灵感和文档进笔记本。

产品名 **NotesToGO**（仓库名 notestodo，「拾贝 Shibei」为旧名/别名）。一个 AI-native 的会议速记 + 笔记/任务工作区。Web MVP → mac/iPad/iPhone。PWA：可「添加到主屏幕 / Dock」直接当原生应用用。

**当前状态（2026-10-31，v0.3.0）**：Phase-1～4 之上完成 openNotion 方向重构——Notion 式页面树 + 块编辑器、多笔记本、多看板、任务树、块评论、AI 面板、GitHub/飞书集成、腾讯会议/飞书妙记转录导入、本机 MCP server。会议垂直链路（录音 → 转录 → 纪要 → 任务）完整保留。桌面包名 **拾贝**。

## 核心特性

- **Notion 式页面工作区**：侧栏页面树（无限嵌套、拖拽换父/防成环、按笔记本分区），空页即写（无向导，标题自动聚焦）；页面列表/表格双视图（列头排序、hover peek、笔记本 tab + tag 筛选）；详情页面包屑「笔记本 › 父页 › 当前页」。
- **块编辑器**（TipTap）：`/` 斜杠菜单原地转换块（文本/H1–H3/待办/列表/引用/代码/分割线，分组+拼音筛选）；块手柄 ⋮⋮ 拖拽移动，点开有 转换为 / 颜色（9 色持久化，`<!-- color -->` 语法对 Obsidian 不可见）/ 评论 / 移动到其它页面 / 删除；`[[双链]]` + 反向链接面板。
- **块评论**：手柄菜单写评论（⌘↵ 提交），页底集中列表，支持解决/删除。
- **任务树**：无限嵌套子任务（拖拽换父、双击改名、截止日期、子树进度 n/m、软删子树），三种视图：树 / 按时间（已过期/今天/本周/稍后/无日期）/ 看板。看板点卡片跳回树并高亮。
- **多看板**（Trello 式）：多板切换/新建/重命名/删除，自定义列增删改，拖拽换列，列底快速加卡；看板卡与任务树同源。
- **一条龙的会议**：任何入口开录即进会中速记（左速记 / 右实时字幕 + 相关资料）；散会后一次 LLM 调用产出标题 + 笔记（速记为骨架）+ 待办。
- **一键录音**：浏览器 MediaRecorder + 5 分钟分片落本地 IndexedDB，崩溃最多丢 5 分钟；桌面版 ScreenCaptureKit 同时混录系统声音（会议对方的声音）；麦克风被拒时按环境给出正确指引。
- **外部会议导入**：腾讯会议 / 飞书妙记导出的转录文本一键粘贴导入（自动解析时间戳 + 说话人），导入即可生成 AI 纪要；飞书日历日程可同步为会议。
- **AI 转录 + 笔记**：BYOK，支持 MiniMax asr-1.0（含说话人分离）/ Deepgram Nova-3 / OpenAI Whisper；自定义模板（`{{var}}` 语法）决定笔记结构，可「重新整理 / 换模板」。AI 提取的待办永不丢出处（时间戳 → 原句匹配 → 无出处三级回退）。
- **AI 面板**：笔记页右侧 ✦ AI 抽屉——总结本页 / 续写一段 / 提取待办，结果一键插入文末；走你配的任意 OpenAI/Anthropic 兼容端点。
- **GitHub 集成**：设置页配 token + repo，open issues 一键导成任务（幂等、PR 自动过滤）。
- **MCP server**：`mcp/` 零依赖 stdio server，把本机 HTTP API 包成 7 个工具（todos CRUD + notes 读/建），Claude Desktop 配置即用。
- **会中实时字幕**：边说边出字（浏览器自带语音识别，免费无需 Key；默认关闭）。散会后没配 ASR Key 时自动用字幕作兜底转录。
- **自动周报**：从本周已完成卡片、会议、任务进度汇总成 Markdown 草稿，一键复制。
- **AI 对话**：会议详情页内置 ChatPanel，对纪要+全文转录提问。
- **日历集成**：订阅任意 .ics URL（Apple iCloud / Google / QQ / Outlook / 飞书日历），点击事件直接启动录音。
- **数据主权**：一键导出 `.zip`（含所有表 + 录音原文），导入可完整恢复。
- **可安装 + 离线启动**：macOS Safari / Edge「添加到程序坞」、iOS「添加到主屏幕」；首次访问后断网也能开。
- **一条龙，零手动步骤（Foresight 式）**：从任何地方开录（侧栏「● 开始录音」/ 今天 / 日历 / ⌘⇧R）都直接进入会中速记页（左速记 / 右实时字幕 + 相关资料），只记关键词，回车即存并带时间锚点。散会后自动转录 → **一次** LLM 调用同时产出标题、完整笔记（以速记为骨架、转录补全细节）和待办。会议页只有「笔记 / 转录 / 资料」三个 Tab，笔记页顶部直接确认待办（每条带原文引用 + 建议 KR，一键「全部确认」）。
- **macOS 桌面版 · Phase-3 系统音频**：Tauri 2 + ScreenCaptureKit 已实装 48kHz/2ch Float32 PCM 采集（`screencapturekit-sys` 0.2 直 ObjC FFI，避开 Xcode Swift toolchain 依赖）；PCM 通过 Tauri event `system_audio:chunk` 推前端并混入录音，banner 显示「mic+system」/「仅麦克风」/「未实装」/「需要屏录授权」四种状态。浏览器 / 未授权时仅录麦克风，UI 永不假装成功。
- **本机内置模型（Foresight 式）**：设置顶部「AI 运行在哪里」三选一——本机内置（推荐，完全离线）/ 云端 API / 自建本地服务，选择立即生效。内置模式由应用自己从 huggingface.co 下载模型（转录：Whisper Large v3 Turbo 574MB / Small 190MB；笔记：Google Gemma 4 E4B 5.2GB / E2B 3.4GB / 12B 7.0GB），后台下载、侧栏显示进度、失败可断点重试；下载完成前照常录音，会议显示「等待模型」，模型就绪后自动转录整理。设置页「数据去向」实时自检会议内容是否离开本机。桌面端推理在应用进程内完成（`src-tauri/src/builtin/`）：whisper-rs（whisper.cpp + Metal）转录，llama-cpp-2（llama.cpp + Metal）跑 Gemma 4，提示词用模型自带的 Jinja 模板渲染（Gemma 4 用新的 `<|turn>` 格式），整理笔记时用 JSON 语法约束输出，思考通道不会混进笔记；录音以 16kHz i16 原始字节经 raw IPC 传给 Rust。模型下载源：Hugging Face / hf-mirror.com / OpenCSG（阿里云北京），国内自动优先国内源、失败自动换源、断点续传（不同源字节不一致时不拼接）；自动识别系统 / Clash 等 HTTP 代理，代理不可用时直连。
- **为中国用户优化**：国内下载源（OpenCSG / hf-mirror）；转录热词（设置里的常用人名 / 术语 + 待办负责人 + 速记短词）让「李四」「PoC」「方案B」等专有名词转对；中文全角标点；whisper 强制简体输出；整理提示词约束负责人 / 截止日期分开写。**说话人区分**（借鉴 VibeVoice-ASR 的「谁 / 何时 / 说了什么」结构化转录）：sherpa-onnx = pyannote 分段 + 阿里达摩院 3D-Speaker CAM++ 中文声纹（共 30MB，随转录模型自动下载），按时间重叠给 whisper 每段标上「说话人 1 / 2 / …」。选型：VibeVoice-ASR-BitNet 自带说话人 + 热词，但中文会议集 WER 明显落后（AISHELL4 27.5% vs FunASR 20.4%）、需单独 fork 编译、模型 1.6GB；SenseVoice 中文最准但不支持热词——实测热词对人名 / 术语提升最大，故保留 whisper（热词）+ 独立说话人区分。
  真实模型实测（两人中文会议 37s 录音，M3，全程离线）：转录 + 说话人区分 6.8s（两位说话人逐段正确），Gemma 4 E4B 生成笔记 + 2 条待办（负责人 / 截止日期正确）约 30s，会议问答 2s。浏览器版如实提示需要桌面版。编译需要 cmake（`brew install cmake`）。开发调试：`localStorage.builtin_mock = '1'` 打开模拟后端。
- **Phase-2 本地模型**：Settings 切到「Local」即可指向 Ollama（`http://127.0.0.1:11434/v1`，无鉴权）/ LM Studio / MLX / 自建 OpenAI 兼容端点；切换 Cloud ↔ Local 不丢另一侧字段。
- **Phase-2 知识库 + Live Assist**：会议详情「助手」Tab 按速记 / 转录自动推相关卡片，pin 到会议持续显示；MVP = keyword + 标题匹配（bigram + CJK 2-gram），无需联网。

## 仓库结构

```
.
├── docs/
│   ├── DESIGN.md            # 产品架构与 UX 设计（Claude Code 主笔）
│   └── SHARED_SPEC.md       # 模块开发规约（多 agent 协作接口）
├── mcp/                     # MCP stdio server（零依赖，包装本机 HTTP API 给 Claude Desktop 等）
├── research/                # 调研报告：竞品、开源方案
├── web/                     # React + Vite + Dexie 前端
│   ├── src-tauri/           # Tauri 2 mac 原生壳（Rust + WKWebView）
│   └── src/
│       ├── audio/           # 录音引擎（分片、异常恢复）
│       ├── pipeline/        # 转录/总结编排、任务恢复
│       ├── transcribe/      # ASR provider 适配器（MiniMax / Deepgram / Whisper）
│       ├── llm/             # LLM 客户端（Anthropic + OpenAI 兼容）+ 模板渲染
│       ├── calendar/        # .ics 订阅解析（ical.js）
│       ├── data/            # .zip 导出/导入（fflate）
│       ├── pages/           # 页面（Meetings / Meeting / Notes / Todos(树+时间) / Board / Templates / Settings）
│       ├── components/      # 共享 UI 原语（MarkdownView / TodoRow / TagPicker / ...）
│       ├── db/              # Dexie 表 + 种子数据 + 设置 KV
│       ├── state/           # Zustand stores（路由 + 录音状态机）
│       ├── lib/             # 工具函数（id / time）
│       └── styles/           # Tailwind v4 + OKLCH 设计令牌
└── relay/                   # （占位，未来 Cloudflare Workers 薄中转）
```

## 启动

```bash
cd web
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # 打包到 dist/
```

**mac 原生客户端（Tauri 2）**：`web/src-tauri/` 已就绪，Rust + WKWebView 壳，体积约 10MB。

```bash
cd web
pnpm tauri dev     # 原生窗口开发模式（自动起 vite）
pnpm tauri build   # 产出 .app / .dmg（target/release/bundle/）
```

**Tauri 端 macOS 授权**（Phase-3 系统音频已实装）：
- `NSMicrophoneUsageDescription`（录音）— 首次启动弹框
- `NSScreenCaptureUsageDescription`（系统音频 loopback）— 首次启用 system-audio 时弹框
- 桌面 App 显示名是 **拾贝**（`cc.secondplanet.shibei`）；「屏幕录制」列表里找「拾贝」，不是 NotesToGO
- 用户在「系统设置 → 隐私与安全性 → 屏幕录制」可手动批准 / 撤销；撤销后自动降级到 mic-only + honest banner

**首次使用**：进入「设置」页填 LLM + ASR 的 API Key（BYOK），今日页就能开始录音。

## 设计语言

- **Notion 系**：浅色 = 白底 + `#f7f7f5` 侧栏 + Notion 蓝 accent（`#2383e2`）+ `#37352f` 正文；深色 = `#191919`/`#202020` 系
- 笔记详情页无卡片框，正文 740px 居中、38px 大标题；块手柄在左侧沟槽
- 4pt 间距网格，150-250ms ease-out 动效
- 文字符号优先（● ▣ ◆ ✎ ✓ ✕），不用 emoji
- 详见 [`web/src/styles/main.css`](web/src/styles/main.css)

## 关键技术决策

| 维度 | 选择 | 理由 |
|------|------|------|
| 平台 | Web（MVP） + Tauri 2 macOS desktop | 一份代码覆盖 mac/iPad/iPhone；桌面版承担系统音频 / 屏录授权 |
| 存储 | Local-first（Dexie / IndexedDB） | 录音是敏感数据；断网可录；同步问题从 Day 1 降级 |
| 转录 | MiniMax / Deepgram / Whisper 多 provider | BYOK；用户按价格/语言/说话人分离能力选择 |
| 总结 | Anthropic-兼容 LLM（MiniMax M3 / Claude） | 中文质量 + 结构化输出 + 长上下文 |
| 本地 LLM | Ollama（首选 preset）/ LM Studio / MLX / 自建 OpenAI 兼容 | Ollama 一行 `ollama serve` 就能跑；Ollama 跑不动再换 MLX |
| 系统音频 | Tauri + ScreenCaptureKit (macOS) | 平台原生 loopback，无需 meeting bot；屏录权限用户在「系统设置」批准 |
| 知识库 | MVP: keyword + 标题匹配（lib/knowledge.ts）| 零外部依赖，中英文混排都可用；升级到 on-device embedding 留接口 |
| 日历 | .ics 订阅（ical.js） | 零 OAuth/审批，覆盖 Apple/Google/QQ/Outlook |
| 导出 | .zip 含音频（fflate） | 数据所有权；14 KB minified |
| 同步 | MVP 不做（M3 用 LWW） | 验证 PMF 前不投入 |

## Phase-2 能力（Foresight 路线图）

> 详细设计见 [`docs/FORESIGHT_OKR_REDESIGN.md`](docs/FORESIGHT_OKR_REDESIGN.md)。本节是给「现在就要跑起来」的用户看的。

### 1. 系统音频（macOS 桌面版 · Phase-3 已实装）

- **Web 路径**（默认）：浏览器仅能拿到麦克风（DRM / 平台限制）。UI 在录音条下方显示 banner：「浏览器中只能录制麦克风；系统声音需 NotesToGO 桌面版，并在「系统设置 → 隐私与安全性 → 屏幕录制」中授权。」
- **Tauri 桌面版路径**（macOS，Phase-3 已实装）：
  1. 启动 NotesToGO 桌面版（`pnpm tauri dev` / 已打包 .app）
  2. 首次录音时 macOS 弹「屏幕录制」授权；批准后 NotesToGO 可同时录到 Zoom/Meet 播放声
  3. 若用户在「系统设置 → 隐私与安全性 → 屏幕录制」中撤销 → 仍可继续，但仅 mic-only（同一 honest banner）
  4. **当前实装**（`src-tauri/src/system_audio.rs`）：CGPreflightScreenCaptureAccess + CGRequestScreenCaptureAccess 探 TCC；拿 SCShareableContent → SCStream（64×64 video + 48kHz/2ch Float32 audio）→ `add_output_handler(Audio)` → `start_capture()`；CMSampleBuffer 转 f32 PCM → Tauri event `system_audio:chunk` 推前端。Phase-4：前端 `audio/systemMix.ts` 把 PCM 排进 AudioContext，与麦克风一起混入 MediaStreamDestination，MediaRecorder 录混合流，系统声音真正写入录音文件。
- **不假装**：UI 永远显示真实状态（仅麦克风 / 麦克风+系统声音 / 未授权屏录 / 非 macOS），不会让用户误以为系统声音已录上。

#### 首次授权：应用内向导（推荐）

桌面版首次启动若未授权屏幕录制，会自动弹出「开启系统声音录制」向导：**一键授权**（触发系统弹窗，并把「拾贝」自动加进屏幕录制列表）→ **打开系统设置**（直达屏幕录制页，只需拨开关）→ **重启拾贝**（macOS 要求重启才生效）。授权状态实时检测，成功后自动切到完成态。之后可从录音条 banner 的「一键开启」或 设置 → 录音采集 → 「授权向导」再次打开。

#### 手动授权步骤（向导打不开时的备选）

1. 启动桌面版（`/Applications/拾贝.app` 或 `pnpm tauri dev`），录音一次 → macOS 自动弹屏录授权
2. 若点了「不允许」或在 System Settings 里撤销：
   - 「系统设置 → 隐私与安全性 → 屏幕录制」中打开 **拾贝** 开关（列表里是「拾贝」，不是 NotesToGO）
   - 杀掉并重启 App（macOS TCC 不会即时刷新已运行的进程）
3. 重启后再录音 → banner 自动翻「麦克风 + 系统声音」


### 2. 本地 LLM

- **Cloud BYOK**（默认）：填 MiniMax / Anthropic / OpenAI 兼容网关的 key；原有功能不变。
- **Local**：填 Ollama / LM Studio / MLX / 自建 OpenAI 兼容端点；API Key 留空即可（Ollama 默认无鉴权），Model 填已下载的模型名。
  - 切到 Local 模式不会清空 Cloud 那一侧的字段；反之亦然。
  - **Ollama 启动**：`ollama serve`（默认 `http://127.0.0.1:11434/v1`）。若模型放在外置盘（如 UGREEN），启动前 `export OLLAMA_MODELS=/Volumes/UGREEN/ollama`。
  - **LM Studio**：开启 Local Server，端口 1234 → Base URL `http://127.0.0.1:1234/v1`。
- **测试连接** 在 Local 模式下会请求 `/v1/models`（Ollama 实现），拉到已下载模型列表即视为通。
- **降级**：若端点不通，UI 给出明确错误（如「HTTP 502: connection refused」），不会让用户以为 LLM 在跑。

### 3. 知识库 + Live Assist

- **添加文件夹**（Settings → 知识库）：粘贴 .md / .txt 路径（HTTP URL 也可；web 路径用 `fetch` 读）。点「重新索引」建索引。
- **Live Assist Tab**（会议详情 → 助手）：
  - 速记非空时自动用速记作 query；录音中持续重检索
  - 找到的相关卡片可「固定」到会议，pinned 卡片持久化在 `pinnedAssistCards` 表
  - 「没有匹配」是空态，不报错
- **MVP 限制**：当前仅 keyword + 标题匹配（bigram Jaccard + CJK 2-gram）；不支持语义检索。
- **升级路径**（接口不变）：替换 `lib/knowledge.ts` 的 `retrieveKnowledge()` 实现，调用方零改动。推荐方向：
  - On-device embedding：EmbeddingGemma 2（Google，~50MB，300M 参数）or `fastembed-wasm`
  - Chunked 索引（按段落 / 滑动窗口 256 token）
  - 向量存储：先 `sqlite-vss`，后续换 `lancedb` 持久化
  - 检索融合：保留 keyword 兜底（title 命中 + 罕见专有名词仍需）

## Phase-3 增量（已合入）

| Gap | 内容 | 关键文件 |
| --- | --- | --- |
| 5 | `@tauri-apps/api` 装好 + `tauriInvoke.ts` 不再走 `new Function('import')` hack | `web/src/lib/tauriInvoke.ts`、`web/package.json` |
| 4 | Local ASR 路径：Settings 加 Cloud \| Local ASR 切换 + Whisper / MLX / faster-whisper openai-compatible 客户端；`asr_mode` / `local_asr_*` 字段 + `resolveASRConfig` 镜像 Local LLM 模式 | `web/src/types.ts`、`web/src/transcribe/openai-whisper.ts`、`web/src/llm/test-connection.ts`、`web/src/pages/settings/SettingsPage.tsx` |
| 2 | Tauri 端 `tauri-plugin-fs` + `tauri-plugin-dialog` 实装；桌面端递归 walk .md/.txt → knowledgeEntries；web 端 fallback 到 HTTP(S)。scope 缩窄到 `$HOME`/`$DOCUMENT`/`$DESKTOP`/`$DOWNLOAD`，**不**放 `"**"`。 | `web/src-tauri/Cargo.toml`、`web/src-tauri/capabilities/default.json`、`web/src-tauri/src/lib.rs`、`web/src/lib/knowledge.ts`、`web/src/pages/settings/SettingsPage.tsx` |
| 3 | PDF 索引（`pdfjs-dist` lazy chunk + worker）：Vite 自动 code-split，用户不碰 PDF 时主 bundle 不增负担。扫描件 / 损坏 → 静默 skip。 | `web/src/lib/pdf.ts`、`web/src/lib/knowledge.ts` |
| 1 | ScreenCaptureKit 系统音频采集（macOS）：`screencapturekit-sys` 0.2 直 ObjC FFI（避开 screencapturekit 11 的 swift-bridge 需要完整 Xcode 的问题）；48kHz/2ch Float32 PCM → Tauri event `system_audio:chunk` → 前端 banner。Phase-4 PR 会把 PCM 拼进 MediaRecorder。 | `web/src-tauri/src/system_audio.rs`、`web/src-tauri/src/lib.rs`、`web/src/lib/tauriSystemAudio.ts` |

### Local ASR 起手（whisper.cpp / MLX STT / faster-whisper 兼容）

```bash
# whisper.cpp（OpenAI-compatible 默认端口 8080）
whisper-server --inference-path  # 或 ./server --model ~/models/ggml-base.en.bin

# MLX STT、faster-whisper 也都暴露 POST {base}/v1/audio/transcriptions，
# Settings → Local ASR → Base URL 填对应端点，API Key 留空（whisper.cpp
# 默认无鉴权）→ 测试连接 → 切 Cloud → Local 用……自动切到本地 STT
```

### Knowledge folder 起手

桌面版 → 「📁 选文件夹」按钮弹系统文件夹选择器 → 选中目录 → 「重新索引」→ 助手 Tab 即可检索。

Web 版（无 Tauri）依然可粘贴 HTTP(S) 直链 .md / .txt（GitHub raw 之类）；本地路径在 web 里会被静默跳过。

### 关键 commit

Phase-3 完整 brief 见 [`docs/CODEX_TASK_PHASE3.md`](docs/CODEX_TASK_PHASE3.md)。Phase-4（已完成）：`system_audio:chunk` PCM 经 `audio/systemMix.ts` 混进 MediaRecorder；Rust 端对 planar 多声道 buffer 做交错。macOS 真机验证需 Fang 授权屏录后手动录一场确认。

## 状态机

```
meeting: recording → processing → transcribed → summarized
                                     ↓
                                  summarizing → summarized
```

所有 `recording → processing` 自动转写 + 总结由 `src/pipeline/jobs.ts` 调度；
断网/崩溃由 IndexedDB 分片兜底，应用重启时 `resumePendingJobs()` 恢复。

## License

MIT