# 活页（Huoye）× notestodo 合并说明

> 分支：`feat/huoye-integration` · 基线：`origin/main`（notestodo v0.7.0）· 合并日期：2026-11-25

本文件说明：**合并了什么、什么是真的运行时集成、什么还只是并排存在、哪些明确没做**。
写给下一个读代码的人，也写给复查这次合并的人。

---

## 1. 合并的真实形态（先说结论）

这次合并是**「同仓共置 + 一条真实数据桥」**，不是把两套 UI 融成一套。准确地说：

| 层面 | 状态 | 说明 |
|---|---|---|
| notestodo 原有应用（`web/`） | **原样保留，未改一行** | 会议速记 / Notion 式页面树 / 任务四视图 / 块评论 / MCP / relay 全部照旧运行 |
| 活页应用（`huoye/`） | **整体迁入，源码、字体、测试、文档齐全** | 独立的 pnpm monorepo：Hono 本地 API + Electron + React，Today 式界面 |
| 数据桥（`integration/`） | **真实运行时集成，有测试** | notestodo 的笔记/会议 ↔ 活页的 Markdown 记忆之间可双向搬运 |
| 单一 UI 融合 | **未做** | 目前是两个可分别运行的 App，共用一个仓库和一条数据桥 |
| 实时同步 | **未做** | 桥是显式导入/导出，不是后台同步 |

也就是说：**不是「活页取代 notestodo」，也不是「两个 App 扔进一个目录就算完」**——
原有 notestodo 一个字节没动，新能力是加法，并且加进去的东西之间有一条可运行的、���测试覆盖的通路。

---

## 2. 仓库结构（合并后）

```
.
├── web/                  # 原 notestodo 应用（v0.7.0），未改动
├── mcp/  relay/  design/  docs/  research/   # 原 notestodo 资产，未改动
├── huoye/                # 活页（Huoye）完整源码，作为独立 pnpm workspace
│   ├── apps/server       # Hono 本地 API：笔记 / 会议 / 任务 / 确认流 / 主动外联
│   ├── apps/web          # React + Vite：今天页 / 对话 / 记忆页 / 笔记编辑器
│   ├── apps/desktop      # Electron 外壳
│   ├── packages/memory   # Markdown 文件记忆：frontmatter、检索、双链、待办
│   ├── packages/core     # 任务 / 确认 / 计量 / 模型调用
│   ├── packages/schema   # 共享类型与 ID
│   ├── packages/ui       # 共享样式（Today 气质）
│   └── docs/             # 活页自己的设计与实现文档
└── integration/          # notestodo ↔ 活页 笔记/会议 数据桥（见下文）
```

`huoye/` 是**自成一体的子工作区**：进入该目录后 `pnpm install && pnpm dev` 即可跑起来，
不依赖仓库根目录；`web/` 也保持自己原来的 `pnpm` 工作区，两者互不干扰。

---

## 3. 活页带来了什么

活页不是「另一个记事本」，它是一套**以对话为主、记忆可检查**的个人助手：
今天页是家，对话框是主沟通方式，记忆是可检查的 Markdown，先确认再行动。

- **今天页**：今天要做的事、会、日程一屏摊开，而不是一个空的 AI 输入框。
- **对话优先**：建任务、改任务、完成、整理会议、写一页笔记，都从对话框发起。
- **一等公民的笔记**：记忆文件本身就是笔记，空页即可写、标题自动聚焦。
- **会议**：录音 → 转录（BYOK）→ 一次整理出标题/纪要/待办，纪要落 Markdown，待办带出处。
- **主动外联（proactive）**：定时生成简报与提醒，**默认关闭**，需要用户显式开启。
- **可检查的记忆**：`$HUOYE_HOME/memory` 下是纯 Markdown + YAML 头，可 grep、可 diff、可进 git。

界面沿用 Today 气质，字体用 OFL 授权的 Figtree Variable / Noto Sans SC（经 `@fontsource` 引入）。

---

## 4. 数据桥：什么是真的接上了

`integration/` 是一个零框架依赖的 TypeScript 包 + CLI，负责两边笔记/会议的真实搬运：

- **notestodo → 活页**：把 notestodo 的笔记/会议对象转成活页风格的 Markdown 文件，
  落到 `memory/notes/` 与 `memory/meetings/`，带活页自己的 YAML 头（`id/title/kind/date/createdAt/updatedAt/pinned/readonly`），
  文件名遵循活页的 slug 规则，**导入后能被活页直接打开**。
- **活页 → notestodo**：把活页记忆目录导出成 notestodo 形状的 JSON。
- **不静默覆盖**：导入遇到同名文件会另起文件名并在报告里列出，绝不覆盖用户已有笔记。
- **有测试**：往返转换、frontmatter 解析、目录落位、同名不覆盖、CJK/超长标题/缺时间戳等边界都有单测。

运行方式见 `integration/README.md`。

**它不是什么**：不是实时同步，不合并两个 App 的数据库，不做冲突合并。
活页用 Markdown 文件记忆，notestodo 用 IndexedDB，两边各有各的真相；
桥的价值是**能真的把内容搬过去并被对方读懂**，而不是让数据看起来「在同一个产品里」。

---

## 5. 明确保留 / 明确没做

**保留**：notestodo 的全部历史与功能（`git log` 未改写，v0.7.0 全部文件原样）、
notestodo 的 MIT License 与全部文档、活页自己的 MIT License。

**没做（且如实写在这里）**：

- 没有把两套 UI 融成一套；今天页 / 侧栏树 / 块编辑器目前并存于两个 App。
- 没有做后台自动同步或冲突合并。
- 主动外联（proactive）在本仓库里**默认关闭**，没有在任何既有工作区上擅自开启。
- 渠道（飞书 / 钉钉 / 企微 / 微信）**尚未真机联调**，需要真实凭据与真实回调地址。
- 部分模型调用尚未在真实账号上跑通（转录与整理的端到端效果待真机验证）。
- 本次合并**未发布** GitHub Release，也**未打 tag**。

---

## 6. 怎么跑起来

```bash
# 原来的 notestodo
cd web && pnpm install && pnpm dev

# 活页
cd huoye && pnpm install && pnpm dev

# 数据桥
cd integration && pnpm install   # 或用仓库已装的 vitest 跑测试
node --experimental-strip-types src/cli.ts import-notestodo <export.json> --into <memoryDir>
```

两套 App 各自独立运行，互不抢端口（活页默认与 notestodo 不共用进程）。
