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
| 平台 | Web（MVP） | 一份代码覆盖 mac/iPad/iPhone；后续 Tauri 包装 |
| 存储 | Local-first（Dexie / IndexedDB） | 录音是敏感数据；断网可录；同步问题从 Day 1 降级 |
| 转录 | MiniMax / Deepgram / Whisper 多 provider | BYOK；用户按价格/语言/说话人分离能力选择 |
| 总结 | Anthropic-兼容 LLM（MiniMax M3 / Claude） | 中文质量 + 结构化输出 + 长上下文 |
| 日历 | .ics 订阅（ical.js） | 零 OAuth/审批，覆盖 Apple/Google/QQ/Outlook |
| 导出 | .zip 含音频（fflate） | 数据所有权；14 KB minified |
| 同步 | MVP 不做（M3 用 LWW） | 验证 PMF 前不投入 |

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