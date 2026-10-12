# NotesToGO · 会议速记 × 嵌套 OKR

> 开会时只记关键词，散会后一键整理成笔记；每个行动项落到正确的 KR 上。

产品名 **NotesToGO**（仓库名 notestodo，「拾贝 Shibei」为旧名/别名）。一个 AI-native 的会议速记 + 嵌套 OKR 应用。Web MVP → mac/iPad/iPhone。PWA：可「添加到主屏幕 / Dock」直接当原生应用用。

## 核心特性

- **一键录音**：浏览器 MediaRecorder + 5 分钟分片落本地 IndexedDB，崩溃最多丢 5 分钟；电平条可见麦在响。
- **AI 转录 + 总结**：BYOK，支持 MiniMax asr-1.0（含说话人分离）/ Deepgram Nova-3 / OpenAI Whisper；用户可自定义模板（`{{var}}` 语法）。
- **Scribble → Polish**：录音时速记是主角（短 bullet，回车自动续写）；停止后「整理笔记」用转录把速记扩写成完整 Markdown，写入会议笔记。原模板纪要 + 待办提取保留为「深度总结」。
- **嵌套 OKR**：战略 O/KR → 季度 O/KR（`period` 如 `2026-Q4`）→ 项目 O/KR → Task；父子规则见 [`web/src/lib/okr.ts`](web/src/lib/okr.ts)，进度按权重逐级汇总。三种视图：**Focus**（默认：Inbox + 本季任务，无树）/ **Quarter** / **Strategy**。会议提取的 ToDo 确认后进 Inbox，或一键挂到建议的 KR；带「证据引文」可跳回转录原文。旧数据的 O/KR 自动迁移为战略层。
- **AI 对话**：会议详情页内置 ChatPanel，对这场会议的纪要+全文转录提问。
- **日历集成**：订阅任意 .ics URL（Apple iCloud / Google / QQ / Outlook），点击事件直接启动录音（预填标题与时间）。
- **数据主权**：一键导出 `.zip`（含所有表 + 录音原文），导入可完整恢复。
- **可安装**：macOS Safari / Edge「添加到程序坞」、iOS Safari「添加到主屏幕」、Android Chrome「安装应用」→ 启动无浏览器 UI。
- **离线启动**：HTML/CSS/JS/icons 已 cache，联网首次访问后断网也能开。
- **Phase-2 系统音频**（macOS 桌面版）：通过 Tauri 2 + ScreenCaptureKit 录制会议播放声；**当前 MVP 命令表面齐全、screencapturekit 集成见 TODO**。浏览器 / 未授权时仅录制麦克风，UI 显示 honest banner，绝不假装成功。
- **Phase-2 本地模型**：Settings 切到「Local」即可指向 Ollama（`http://127.0.0.1:11434/v1`，无鉴权）/ LM Studio / MLX / 自建 OpenAI 兼容端点；切换 Cloud ↔ Local 不丢另一侧字段。
- **Phase-2 知识库 + Live Assist**：会议详情「助手」Tab 按速记 / 转录自动推相关卡片，pin 到会议持续显示；MVP = keyword + 标题匹配（bigram + CJK 2-gram），无需联网。

## 仓库结构

```
.
├── docs/
│   ├── DESIGN.md            # 产品架构与 UX 设计（Claude Code 主笔）
│   └── SHARED_SPEC.md       # 模块开发规约（多 agent 协作接口）
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
│       ├── pages/           # 页面（Today / Meetings / Meeting / Notes / Todos / Templates / Settings）
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

**Tauri 端 macOS 授权**（Phase-2 system-audio 路径）：
- `NSMicrophoneUsageDescription`（录音）— 首次启动弹框
- `NSScreenCaptureUsageDescription`（系统音频 loopback）— 首次启用 system-audio 时弹框
- 用户在「系统设置 → 隐私与安全性 → 屏幕录制」可手动批准 / 撤销；撤销后 NotesToGO 自动降级到 mic-only + 同一 honest banner
- 当前 MVP：Rust 端命令表面齐全，SCStream 实际接线见 `src-tauri/src/lib.rs` 的 `TODO(system-audio)` 标记

**首次使用**：进入「设置」页填 LLM + ASR 的 API Key（BYOK），今日页就能开始录音。

## 设计语言

- **浅色默认**：暖纸色画布 `oklch(97.9% 0.009 85)` + 白色提升层、细线分隔、柔和阴影；墨色正文
- 深色可选：柔和炭灰 `oklch(23–30%)`，不是纯黑
- 唯一强调色：低饱和青蓝 `oklch(51% 0.075 205)`（深色下提亮）
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

### 1. 系统音频（macOS 桌面版）

- **Web 路径**（默认）：浏览器仅能拿到麦克风（DRM / 平台限制）。UI 在录音条下方显示 banner：「浏览器中只能录制麦克风；系统声音需 NotesToGO 桌面版，并在「系统设置 → 隐私与安全性 → 屏幕录制」中授权。」
- **Tauri 桌面版路径**：
  1. 启动 NotesToGO 桌面版（`pnpm tauri dev` / 已打包 .app）
  2. 首次录音时 macOS 弹「屏幕录制」授权；批准后 NotesToGO 可同时录到 Zoom/Meet 播放声
  3. 若用户在「系统设置 → 隐私与安全性 → 屏幕录制」中撤销 → 仍可继续，但仅 mic-only（同一 honest banner）
  4. **当前 MVP 状态**：Rust 端命令 `system_audio_status` / `system_audio_start` / `system_audio_stop` 已注册到 `invoke_handler!`；实际 SCStream 接线（screencapturekit crate 集成）见 `src-tauri/src/lib.rs` 的 `TODO(system-audio)` 标记。本期前置工作就绪，PR 接入 screencapturekit 即可启用。
- **不假装**：UI 永远显示真实状态（仅麦克风 / 麦克风+系统声音 / 未实装），不会让用户误以为系统声音已录上。

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