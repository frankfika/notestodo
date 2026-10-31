# NotesToGO 产品 UX 对标调研（2026-10）

> 调研日期：2026-10-31。对标对象：Notion（AI 能力 + 任务管理）、Trello（看板卡片交互）、Google AI Edge Foresight / Pieces / Obsidian（本地优先 AI 零配置范式）。
> 基线：README v0.3.0 特性清单 + 今日已修清单（任务筛选与自然语言快速添加、看板卡片就地编辑、笔记↔任务互链、全局 AI 助手 ⌘J、onboarding 重写、本地模型一键下载）——这些不重复列入 backlog。

## 1. Notion AI 对标表

Notion AI 在 2025–2026 已从「写作助手」演进为「工作区里的 AI 同事」，核心形态：侧栏常驻入口 + ⌘J + 选中文本浮动菜单 + 数据库列级自动填充。

| Notion AI 能力 | 入口形态 | NotesToGO 现状 |
|---|---|---|
| Notion Agent（跨页面/库执行多步操作：建页、改库、批量整理） | 侧栏 AI 面板，对话式下达任务 | **部分**：⌘J 全局助手已打通，但以问答/生成为主，缺「跨实体批量操作」（如「把本周会议待办全建到看板」这类 agentic 多步执行） |
| AI 会议笔记（无 bot 录音转录 + 摘要 + 行动项） | 页面内 `/AI 会议笔记` 块 | **已有且更强**：录音→转录→纪要→待办一条龙是我们的主链路；速记骨架 + 待办出处回链是 Notion 没有的 |
| AI 写作（续写、改写、总结、改语气、翻译） | 选中文字浮动菜单 + ⌘J + 空格唤起 | **部分**：AI 面板有「总结本页 / 续写 / 提取待办」，但**缺选中文字的浮动菜单**（选中即改：改写/缩写/翻译/改语气），目前只能整页操作、结果只能插文末 |
| 数据库自动填充（Autofill：AI 摘要列、关键词提取列、情绪列，随行更新） | 数据库属性列类型选 AI | **缺失**：我们没有结构化属性列概念，笔记列表/表格视图没有 AI 生成列 |
| Enterprise Search + AI Connectors（跨 Slack/Drive/GitHub 问答） | 侧栏搜索框直接问 | **缺失**：我们只有本机知识库 keyword 匹配（bigram + CJK 2-gram），无语义检索、无外部源 connector；MCP server 方向相反（把数据暴露给 Claude，而非从外部拉） |
| Research Mode（深度调研出长报告） | AI 面板内模式切换 | **缺失**（优先级低，与产品定位不符，可不做） |
| Custom Agents（定时/触发器自动跑任务） | 设置中心配置 | **缺失**（P2，自动周报已是最小雏形） |

**小结**：主链路（会议 AI）我们领先；通用写作 AI 差「选中文本浮动菜单」这一关键形态；agentic 批量操作和语义检索是 ⌘J 的下一步。

## 2. 任务/看板差距

### Notion 任务管理

| 能力 | Notion 做法 | NotesToGO 现状 |
|---|---|---|
| Sub-tasks | 任务内嵌子项，父任务显示进度 | **已有**：无限嵌套任务树 + 子树进度 n/m |
| 依赖（blocking/blocked-by） | 任务间依赖连线，被阻塞任务有标识，日期冲突自动提示 | **缺失**：任务树只有父子关系，无横向依赖 |
| 看板分组 | 可按任意 select/person 属性分组，一键切换分组维度 | **部分**：看板列固定为自定义列（≈状态分组），不支持按「截止日期 / 标签 / 来源会议」临时切换分组 |
| 日历视图 | 任务按 due date 上日历，周计划拖拽排期 | **部分**：有「按时间」视图（已过期/今天/本周分组）但不是日历形态，不能拖到某天改期 |
| My Tasks | 跨库聚合「分配给我的所有任务」单一视图 | **部分**：任务树本身是单一来源，但缺「今天该做什么」的个人聚合视角（今日页偏会议，未聚合任务到期+看板进行中） |

### Trello 卡片就地编辑细节（今日已修标题就地编辑，以下为剩余差距）

| 细节 | Trello | NotesToGO 差距 |
|---|---|---|
| 快捷键体系 | hover 卡片按 E 快速编辑、N 在下方插卡、C 归档、L 开标签、数字键 1–0 打标签、⌘↵ 保存、? 看全部快捷键 | **缺失**：看板几乎无键盘操作，全靠鼠标 |
| Checklist | 卡片内多清单 + 进度条，卡面显示 n/m 徽标 | **部分**：子树进度 n/m 在树视图有，看板卡面上不显示子任务进度徽标 |
| 标签 | 色块标签、卡面可直接看色条，; 切换标签名显隐 | **部分**：任务有 tag 筛选，但看板卡面无彩色标签条 |
| Cover | 卡片封面色/图，一眼分区 | **缺失**（P2，可做纯色 cover 复用块颜色体系） |
| 撤销 | Z 撤销归档/移动/改名 | **缺失**：拖拽换列/软删无 undo，只有软删可恢复 |
| 到期徽标 | 卡面显示 due date，过期变红 | **部分**：树视图有，看板卡面缺失或弱化 |

**小结**：任务树结构已齐（嵌套优于多数竞品）；差距集中在**看板卡面信息密度**（进度/标签/日期徽标）、**键盘操作**、**依赖关系**和**日历排期**四块。

## 3. 零配置范式（本地优先 AI）

| 产品 | 零配置做法 | 对 NotesToGO 的启示 |
|---|---|---|
| **Google AI Edge Foresight**（2026-10 发布，~160MB Mac 应用） | 首次运行自动后台拉取端侧模型（EmbeddingGemma 2 + Gemma 4），全程无需账号/Key/设置；索引本地文件夹/PDF/书签做端侧 RAG；完全离线可飞航模式 | 我们「本机内置三选一 + 一键下载 + 断点续传 + 国内源自动切换」已对齐此范式。**剩余差距**：下载完成前的等待态引导（Foresight 是静默后台下完即用，我们「等待模型」态的进度可见性和预估时间可以更明确） |
| **Pieces** | 桌面应用装完即用，本地推理默认开，云端模型是可选项而非必经配置；LTM 被动捕获无需用户配置 | 启示：**默认路径应该一条设置都不用填**。我们 onboarding 重写后仍需验证：新用户不碰设置页能否完成「录一场会→拿到纪要」闭环（内置模型模式下应该可以——这是对标 Foresight 的核心卖点，值得在 onboarding 里作为默认推荐路径高亮） |
| **Obsidian + 插件** | 反面教材：Local GPT 需先装 Ollama、`ollama serve`、再装 AI Providers 依赖插件、填 localhost:11434——多进程多插件依赖是普通用户的流失点 | 我们内置模式（进程内 whisper-rs + llama-cpp-2）恰好消灭了这类摩擦，这是相对 Obsidian 生态的硬优势，应在官网/README 明确讲 |

**结论**：零配置范式我们已经走对（甚至早于 Foresight 实装），剩下的是「等待模型下载期间不阻塞录音」的体验打磨和把「离线可用」作为对外叙事主线。

## 4. 优先级 backlog

> 不含今日已修项。规模：S < 半天，M = 1–3 天，L > 3 天。

| # | 优先级 | 事项 | 对标来源 | 建议做法 | 规模 |
|---|---|---|---|---|---|
| 1 | P0 | ⌘J 助手升级为 agentic 多步执行 | Notion Agent | 给 ⌘J 加工具调用层（复用 MCP server 的 todos/notes 工具定义），支持「把 X 全建成任务」类批量操作；先 3–5 个工具，逐条确认执行 | L |
| 2 | P1 | 选中文本浮动 AI 菜单 | Notion 写作助手 | TipTap BubbleMenu：选中即出「改写/缩写/扩写/翻译/提待办」，原地替换或插入下方 | M |
| 3 | P1 | 看板卡面信息徽标 | Trello | 卡面加 due date（过期变红）、子任务进度 n/m、彩色标签条；纯展示层 | S |
| 4 | P1 | 看板键盘操作 | Trello | hover 卡片 E 编辑 / N 插卡 / C 归档 / ⌘↵ 保存；设置页或 ? 键列出快捷键 | M |
| 5 | P1 | 「我的今天」任务聚合视图 | Notion My Tasks | 今日页聚合：今天到期 + 已过期 + 看板进行中卡片，一屏看清；复用现有筛选逻辑 | M |
| 6 | P1 | 拖拽改期（时间视图/日历） | Notion 日历视图 | 先在「按时间」视图支持跨组拖拽改 due date（分组即日期桶，改动小）；完整日历网格视图后置 | M（日历网格为 L） |
| 7 | P1 | 知识库语义检索升级 | Notion Enterprise Search / Foresight RAG | 按 README 既定路线：EmbeddingGemma 2 / fastembed-wasm 端侧 embedding + 分块索引，保留 keyword 兜底 | L |
| 8 | P1 | 模型下载等待态打磨 | Foresight | 下载进度带预估剩余时间；「等待模型」的会议在就绪后桌面通知；首启默认推荐内置模式并预下载 | S |
| 9 | P2 | 任务依赖（blocking/blocked-by） | Notion | 任务加 depends_on 字段，树视图徽标提示「被阻塞」；不做甘特图 | M |
| 10 | P2 | 看板分组维度切换 | Notion board group-by | 看板顶部切「按列 / 按标签 / 按来源会议」；复用现有筛选状态 | M |
| 11 | P2 | 操作撤销（拖拽/归档） | Trello Z | 全局轻量 undo 栈，仅存「移动前位置/归档前状态」，toast 内撤销按钮 | M |
| 12 | P2 | 数据库 AI 自动填充列 | Notion Autofill | 笔记表格视图加可选「AI 摘要列」，惰性生成、按行缓存 | L（依赖结构化属性体系，建议缓做） |
| 13 | P2 | 自动周报 → 定时 Custom Agent 雏形 | Notion Custom Agents | 周报已有；加「每周五自动生成草稿并通知」即最小闭环 | S |

**取舍说明**：P0 只放 ⌘J agentic 化——它是把「AI 助手」从问答玩具变成生产力中枢的断层差距，且工具层可复用 MCP 已有成果。语义检索（#7）排 P1 末位是因为 keyword 匹配当前可用，而 #2–#6 都是高频触感差距。Notion Research Mode 与 Custom Agents 完整版与产品「本地优先会议工作区」定位不符，不做或仅做 #13 的最小形态。

---
**信息来源**：[Notion AI 官方页](https://www.notion.so/product/ai)、[Notion AI Review 2026 (eesel)](https://www.eesel.ai/blog/notion-ai-review)、[Notion 任务数据库指南](https://www.notion.com/id/help/guides/give-your-to-dos-a-home-with-task-databases)、[Notion 子任务与依赖](https://chasebowers.com/vi/help/tasks-and-dependencies)、[Trello 官方快捷键](https://trello.com/shortcuts)、[Atlassian Trello 快捷键文档](https://support.atlassian.com/trello/docs/using-keyboard-shortcuts-in-trello/)、[Google AI Edge Foresight 解析](https://madrobot.blog/2026/10/08/google-ai-edge-foresight-mac-app-offline-meeting-notes-embeddinggemma-2/)、[Foresight 实测](https://justbeingresourceful.com/2026/10/29/google-ai-edge-foresight-free-offline-meeting-notes-for-mac/)、[Pieces 介绍](https://claude-code-alternatives.com/ide-extensions/pieces-for-developers/)、[Obsidian Local GPT 插件](https://community.obsidian.md/plugins/local-gpt)、[Obsidian 本地 LLM 搭建指南](https://insiderllm.com/guides/obsidian-local-llm-guide/)
