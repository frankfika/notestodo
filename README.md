# 拾贝 Shibei · AI 会议笔记与待办

> 开会时只管说话，散会时纪要和待办已经排好。

一个 AI-native 的会议笔记 + 三级待办应用。Web MVP → mac/iPad/iPhone。

## 仓库结构

```
.
├── docs/
│   ├── DESIGN.md            # 产品架构与 UX 设计（Claude Code 主笔）
│   └── SHARED_SPEC.md       # 模块开发规约（多 agent 协作接口）
├── research/                # 调研报告：竞品、开源方案
├── web/                     # React + Vite + Dexie 前端
│   └── src/
│       ├── audio/           # 录音引擎
│       ├── pipeline/        # 转录/总结编排
│       ├── transcribe/      # ASR provider 适配器（MiniMax / Deepgram / Whisper）
│       ├── llm/             # LLM 客户端 + 模板渲染
│       ├── pages/           # 页面（Today / Meetings / Todos / Notes / Templates / Settings）
│       ├── components/      # 共享 UI 原语
│       ├── db/              # Dexie 表 + 种子数据
│       ├── state/           # Zustand stores
│       ├── lib/             # 工具函数
│       └── styles/          # Tailwind v4 + 设计令牌
└── relay/                   # 薄中转（Cloudflare Workers）
```

## 启动

```bash
cd web
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # 打包到 dist/
```

## 设计 token**（自定义 `@theme inline`，见 `web/src/styles/main.css`）

- 主背景 `oklch(16%)` + 提升层 `oklch(19.5%)`
- 唯一强调色：青蓝 `oklch(70% 0.12 230)`
- 暗色默认，4pt 间距网格，OKLCH 渐变

## 关键技术决策（详见 DESIGN.md）

| 维度 | 选择 | 理由 |
|------|------|------|
| 平台 | Web（MVP） | 一份代码覆盖 mac/iPad/iPhone；后续 Tauri 包装 |
| 存储 | Local-first（Dexie / IndexedDB） | 录音是敏感数据；断网可录；同步问题从 Day 1 降级 |
| 转录 | MiniMax / Deepgram / Whisper 多 provider | BYOK；用户按价格/语言/说话人分离能力选择 |
| 总结 | Anthropic-兼容 LLM（MiniMax M3 / Claude） | 中文质量 + 结构化输出 + 长上下文 |
| 同步 | MVP 不做（M3 用 LWW） | 同步是独立大坑，验证 PMF 前不投入 |

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