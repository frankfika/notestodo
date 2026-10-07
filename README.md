# 拾贝 Shibei · AI 会议笔记与待办

> 开会时只管说话，散会时纪要和待办已经排好。

一个 AI-native 的会议笔记 + 三级待办应用。Web MVP → mac/iPad/iPhone。PWA：可「添加到主屏幕 / Dock」直接当原生应用用。

## 核心特性

- **一键录音**：浏览器 MediaRecorder + 5 分钟分片落本地 IndexedDB，崩溃最多丢 5 分钟；电平条可见麦在响。
- **AI 转录 + 总结**：BYOK，支持 MiniMax asr-1.0（含说话人分离）/ Deepgram Nova-3 / OpenAI Whisper；用户可自定义模板（`{{var}}` 语法）。
- **三级待办**：Objective > KR > Task，支持 tags、日期、委派人员；会议提取的 ToDo 带「证据引文」可一键跳回转录原文。
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

**首次使用**：进入「设置」页填 LLM + ASR 的 API Key（BYOK），今日页就能开始录音。

## 设计语言

- 主背景 `oklch(16%)` + 提升层 `oklch(19.5%)`，暗色默认
- 唯一强调色：青蓝 `oklch(70% 0.12 230)`
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