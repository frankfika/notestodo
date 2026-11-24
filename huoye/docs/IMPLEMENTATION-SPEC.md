# 活页（Huoye）实现规格

- 文档日期：2026-11-23（Asia/Shanghai）
- 受众：用 Claude Code（或同等编码助手）从零脚手架仓库的实现者
- 目标：一份**不再需要额外产品决策**就能开工的规格。命名、栈、目录、数据模型、权限、MVP 边界和第一个里程碑均已拍板。
- 证据来源（本目录，只读对照，不要把其中的 Today 资源拷进产品仓）：
  - `OPEN-SOURCE-MEMORY.md`
  - `PRODUCT-MECHANISM.md`
  - `TODAYAI-TEARDOWN.md`
  - `hands-on/app/REPORT.md`
- 本规格**不是** Today 的复刻说明书，而是开源个人助手「活页」的实现合同。只学信息架构与交互原则，不复制官方图标、April / Spark 画作或营销文案。

---

## 0. 必须遵守的诚实边界

尚未进入 Today 付费应用，因此下列能力只来自客户端静态分析、i18n 与公开 API 形状，**不是** live App 实测。实现时按本规格落地我们自己的行为，并在代码注释 / 文档中标为 **「推断，待日后对照」**，不要写成「已与 Today 正式 App 对齐」：

1. Chat 主界面的完整交互（消息分组、任务卡回写、语音、分享链接）
2. Today 晨间 / 晚间简报的类型、调度时刻、小组件协议
3. Tasks 状态机在聊天里的确认交互、推荐任务、Routines / Ongoing 详情
4. Memories 编辑器的冲突、草稿、pin、三张总览卡的正式 UI
5. 日记生成节奏，以及哪些文件在正式 App 里只读
6. 「Next reflect: tonight around 3 am」是否为真实服务端时刻、时区以谁为准、用户能否改
7. 设置目录里飞书 / Lark / 钉钉的真实 `comingSoon` / hidden / connectable flag
8. 健康信号、报告、录音摘要的真实数据模型

禁止事项：

- 不要启动 Today 试用，不要发明未见过的 live App 行为并当成事实
- 不要把 `todayai-research/assets/fonts/` 或官方截图、图标、人像拷进产品仓
- 不要以 Kortix Suna（Elastic License 2.0）为底座
- 不要用非官方微信协议 / 未说明授权的个人号 hook
- 不要把 SuperMemory 的闭源预编译二进制当记忆后端
- 不要把 AGPL 项目（Khoj、Honcho、Logseq、Cherry Studio、Joplin 应用等）或 ELv2 项目当核心依赖，以保持 MIT 许可干净
- 软件本身不得做「不订试用就进不了核心功能」的付费墙

---

## 1. 产品名与定位

| 项 | 决定 |
| --- | --- |
| 中文名 | **活页** |
| 英文名 / 仓库名 / npm scope | **Huoye** / `huoye` / `@huoye/*` |
| 默认助手名 | **叶**（用户可改；「给我一个名字」从小型原创词表随机，词表不得包含 Spark、Iris、Momo、April、Today） |
| 许可证 | **MIT** |
| 一句话定位 | 开源、本地优先的个人助手：记忆是可检视、可导出的 markdown 文件树，对外行动必须先确认，飞书、钉钉、微信作为一等通道；软件免费，模型费用由用户自带密钥承担。 |

取名理由（实现时不必再讨论）：「活页」直接对应「可抽出、可手改、可导出的页面」，和记忆文件树同构；英文 Huoye 在 GitHub / npm 上可独占，不是 Today / Iris / Spark 的换皮名。应用图标自行设计（建议极简几何，避免冒号两点的 Today 图标造型）。

---

## 2. 技术栈（已拍板）

| 层 | 选择 | 简要理由 |
| --- | --- | --- |
| 语言 | TypeScript 5.x，`strict` | 桌面、网页、本地服务、MCP 工具共享同一套类型；Claude Code 脚手架成本最低 |
| 运行时 | Node.js 22 LTS | 生态稳，避免首个里程碑再引入 Bun/Rust 工具链分叉 |
| 包管理 | pnpm workspaces（pnpm 9+） | monorepo 标准路径 |
| 校验 | zod 3 | 运行时 schema 与 `packages/schema` 同源 |
| UI | React 19 + Vite 6 + React Router 7 + Tailwind CSS 4 | 本地优先不需要 SSR；不要用 Next.js，以免再出现 `/settings` 这类空路由 |
| 组件与状态 | 自研 `@huoye/ui`；TanStack Query + Zustand（会话 UI） | 不引入重型组件库来「冒充」Today |
| 本地 API | Hono，跑在 Node；默认 `127.0.0.1:8787` | 轻、类型友好，Electron 主进程可同进程或 sidecar 挂载 |
| 网页 | Vite dev `127.0.0.1:5173`，只反向代理 `/api` | `pnpm dev` 一条命令同时起 UI 与 API |
| 桌面 | Electron（macOS / Windows / Linux 对等） | 本机文件夹、剪贴板、以后的电脑控制都要第一等；首个里程碑只建包结构，不强制打出安装包 |
| 记忆真相 | 本地 markdown 文件树 | 见第 5 节；**不是**向量库 |
| 索引 / 任务 / 用量 | SQLite（`better-sqlite3` + Drizzle） | FTS5 做关键词检索；可删库重建，不得反向当真相 |
| 记忆版本 | 默认在 `memory/` 初始化 git 仓库；无 git 时降级为 `activities/` 快照 | 对齐 Letta MemFS 的冲突与历史，但不 fork Letta |
| 测试 | Vitest；关键路径用测试夹具，不访问网络 | 见第 12 节「完成标准」 |
| 国际与时区 | 默认 `zh-CN`，同步提供 `en`；时间默认 Asia/Shanghai，可改 | 用户在此时区 |
| 代码风格 | oxlint 或 eslint + prettier，CI 可跑 `pnpm typecheck && pnpm test && pnpm lint` | 首个 PR 就要绿 |

不采用：Next.js、Suna、SuperMemory server、非官方微信协议、把 Mem0 Platform / Zep Cloud 独有能力写成默认依赖。Mem0 OSS 或 LangMem 只作为 **v1 之后可选的抽取库**，写入结果必须变成对 `about-you/*.md` 的补丁，而不是另一份真相。

---

## 3. 仓库布局

仓库根目录名 `huoye`。建议以后开在独立 git 仓，不要把本调研目录当产品仓。

```
huoye/
  LICENSE                          # MIT
  README.md                        # 产品一句话、pnpm dev、默认目录、BYOK、许可证
  CONTRIBUTING.md
  package.json                     # private: true；scripts 见第 12 节
  pnpm-workspace.yaml              # apps/* 与 packages/*
  tsconfig.base.json
  .gitignore                       # 忽略 secrets、.huoye-tmp、coverage、以及用户记忆目录
  apps/
    web/                           # Vite + React 界面
    server/                        # Hono 本地 API（也可被 desktop 引用）
    desktop/                       # Electron 壳；首个里程碑可只放 package.json 与 README stub
  packages/
    schema/                        # zod + 导出的 TS 类型（记忆、任务、确认、用量、设置）
    config/                        # 默认路径、端口、环境变量名
    memory/                        # 文件树、frontmatter、git/activities、FTS 索引
    core/                          # agent 循环、工具总线、权限与确认
    connectors/                    # Connector 接口 + 本地文件夹/空壳云连接器
    metering/                      # token 事件、BYOK 估算、汇总
    ui/                            # 视觉系统、五栏壳、玻璃卡、编辑器外壳
  fixtures/
    memory-seed/                   # 五个核心画像文件与日记的空模板（原创文案）
    agent-seed/
      AGENT.md                     # 默认人格与规则（人对，或确认后改）
  docs/
    IMPLEMENTATION-SPEC.md         # 本规格的副本或符号链接说明
```

路径别名：`@huoye/schema`、`@huoye/config`、`@huoye/memory`、`@huoye/core`、`@huoye/connectors`、`@huoye/metering`、`@huoye/ui`。

### 3.1 默认磁盘布局（用户机器上）

工作区必须是用户看得见、能用普通编辑器打开的目录，而不是只藏在 `~/.config` 里的黑盒。

```
$HUOYE_HOME/                       # 默认 ~/Huoye，可用环境变量或设置改
  config.json                      # 非密钥设置（模型名、主动性、语言、时区）
  secrets.json                     # 仅本地、权限 0600；有系统钥匙串时优先改存钥匙串
  agent/
    AGENT.md                       # 助手人格与硬规则
  memory/                          # 第 5 节的整棵记忆树；默认为 git 仓库
  data/
    index.sqlite                   # FTS、任务、确认、用量、审计；可重建
    index.sqlite-wal
  logs/
    audit.jsonl                    # 只追加的人可读审计（也写入 sqlite）
  tmp/
```

环境变量：`HUOYE_HOME`、`HUOYE_PORT`（API，默认 8787）、`HUOYE_WEB_PORT`（默认 5173）、`HUOYE_HOST`（默认 127.0.0.1，禁止默认绑 0.0.0.0）。

---

## 4. 版本规划

### 4.1 MVP（必须能日常使用，且没有任何付费墙）

可用定义：**不注册云账号、不绑卡、不连任何云应用**，只配置一个模型密钥（或使用显式的 Mock Provider 开发模式），就能完成：聊天、查看和编辑记忆文件树、看到 Today 首页、创建并查看基础任务、在设置里管理模型密钥。

必须交付：

1. **五栏壳**：聊天、今天、任务、记忆、助手档案。移动宽度底部 Tab，桌面宽度左侧或顶部导航，但五个表面同一套路由。
2. **聊天**：多轮文本对话、流式输出、Markdown 渲染、会话列表与新建。附件 / 语音可在 UI 留入口但标「未就绪」。无密钥时给出清晰的设置引导，而不是空白报错。
3. **记忆**：按第 5 节生成默认树；文件树浏览、新建 / 重命名 / 删除文件夹与文件、打开 Markdown 编辑器、保存、pin、导出整棵树为 zip 或直接打开文件夹。`ABOUT.md` 按固定顺序拼出「关于你」只读一览（源文件仍可编辑）。
4. **今天（简化）**：日期与问候、一块「今日任务」摘要、一块由本地记忆拼出的短简报（可手动点「生成今日简报」，不宣称已对齐 Today 的晨夕调度）、健康卡与录音卡在信息架构里占位并明确写「未就绪」。
5. **任务（基础）**：创建 / 列表 / 打开 / 取消「即时任务」；状态至少包括 `draft`、`pending_confirmation`、`running`、`completed`、`failed`、`cancelled`。定时任务在 UI 上可见分段，并由 API 进程内的调度器到点触发；错过的时间在进程恢复后补跑一次，周期任务不会把错过的每一次都补上。
6. **BYOK**：设置 → 模型。内置至少 `openai-compatible`（base URL + API key + model id）与一个 `mock` provider。密钥不进 git、不进遥测、API 响应不得回显完整密钥。
7. **设置（必须有页面，部分可做空壳）**：模型与密钥、连接器、通道、Skills / MCP、用量、主动性、工作区路径、导出与删除。连接器 / 通道 / MCP 在 MVP 可以是「即将到来」的诚实空态，但路由和导航必须在。
8. **引导**：可跳过。唯一建议填写的是用户称呼（可跳过则用「你」）。连接器**零门槛**。无试用墙、无套餐墙、无「先连两个云应用才能继续」。
9. **权限**：凡对外写（发消息、改第三方、写非记忆目录的文件、跑 shell）必须先确认。MVP 即使还没有真实飞书写入，确认中心 UI 与数据模型必须存在，并用一个「演示：拟发送一条消息」的 fixtures 跑通批准 / 拒绝。
10. **用量**：每次模型调用写一条 `UsageEvent`，设置里能看到今日 / 本月 token 与估算费用（BYOK 用用户填写的单价，缺省则只显示 token）。

明确不做（但要在 UI 里诚实占位或隐藏）：健康数据接入、录音 / 会议纪要、电脑控制、云电脑、浏览器自动操作、夜间整理、多设备同步、计量中转售卖、社区 Skills 市场。

### 4.2 v1（可称为「完整的本地个人助手」）

- Electron 桌面端，macOS / Windows / Linux 能力对等：自选文件夹（不得把「其他文件」默认为整个家目录）、剪贴板需明示授权、shell 必须出同意框且默认工作目录受限。
- 飞书、钉钉官方 SDK 的只读 + 需确认的写入；微信通道按腾讯 `openclaw-weixin`（MIT，iLink）的集成方式接入，而不是非官方协议。
- 记忆检索：FTS5 默认开；可选向量索引（sqlite-vec 或 LanceDB），可关、可重建。
- 核心画像补丁流：助手提出 diff，用户接受 / 编辑后保存 / 拒绝。
- 任务跑完整 agent 循环，写操作进确认队列；定时任务调度真正执行。
- 简报：用户可设「早上 / 晚上」两个锚点（默认本地时区 08:00 与 21:00，**这是活页自己的默认，不是已验证的 Today 时刻**）。
- 开放性：Skills 目录（兼容常见 agent skill 文件夹约定）+ MCP（stdio / HTTP）。
- 审计日志可检索；导出 / 删除账号级数据永不收费、永不要求先订套餐。
- 主动性旋钮生效。

### 4.3 更后

- 可选自托管同步（用户自己的服务器）
- 可选计量中转（活页不靠订阅墙赚钱；中转按 token 计价，且必须与 BYOK 并存，可一键关掉）
- 夜间整理（reflect / dream）把日记中的稳定事实提升为核心文件补丁，并留下人可读报告
- 健康卡、录音卡的真实数据
- 向量 + 可选图谱（Graphiti）只做索引
- Mem0 OSS / LangMem 作为可选抽取器
- 社区连接器与 skill 市场
- 多配置文件 / 多工作区

---

## 5. 记忆模块

记忆的唯一真相是磁盘上的 markdown 文件树。SQLite FTS、向量、图谱、抽取流水线都是索引或建议层，**重建或删掉不得丢失用户承认的事实**。

### 5.1 默认目录（必须按此生成，不要再改名）

与 `OPEN-SOURCE-MEMORY.md` §2 对齐：

```
memory/
  ABOUT.md                       # 可选生成：把非空「关于你」文件按约定顺序拼成一览
  about-you/
    profile.md                   # 称呼、时区、基本档案
    identity.md                  # 自我认同、价值观、沟通风格
    lifestyle.md                 # 生活习惯、兴趣
    work.md                      # 工作与项目
    devices.md                   # 设备与常用工具
    …                            # 用户或助手新建的其它文件，按文件名排序
  diaries/
    YYYY-MM-DD.md                # 由聊天 / 连接器随时间追加
  uploads/                       # 用户导入
  health/                        # 预留；MVP 在 UI 标「未就绪」
  recordings/                    # 预留录音转写与笔记摘要；MVP 标「未就绪」
  pins.json                      # pin 列表；也允许文件 frontmatter 写 pinned: true
  activities/                    # 无 git 时的版本快照与活动流
```

「关于你」拼接顺序固定为：`profile.md`、`identity.md`、`lifestyle.md`、`work.md`、`devices.md`，其余按文件名排序，跳过空文件。这是功能划分，不是对 Today 文案的复制。

助手人格与规则放在工作区 `agent/AGENT.md`，**不要**放进 `about-you/`。关于用户 vs 关于助手必须分家。

`ABOUT.md` 文件头须标明「由活页根据 about-you/ 生成，请改源文件」。用户若手改 `ABOUT.md`，保存时提示将覆盖，或直接把它当派生文件只读。

### 5.2 文件格式

每个 markdown 文件允许可选 YAML frontmatter：

```yaml
---
id: mem_...                    # 创建时生成，重命名不改
title: 工作与项目
kind: about_you | diary | upload | system_summary | other
pinned: false
readonly: false
createdAt: 2026-11-23T10:00:00+08:00
updatedAt: 2026-11-23T10:00:00+08:00
---
```

日记追加块建议格式（实现必须带出处，文案可微调，不要抄 Today 原句）：

```markdown
## 14:12 · 来自聊天

- 事实……
- 出处：chat:c_xxx / turn:t_xxx
```

### 5.3 写入策略（必须按表实现）

| 目标 | 默认策略 |
| --- | --- |
| 外部系统（邮件、日历、IM、云盘、工单、频道消息） | **必须先确认再写**，见第 7 节 |
| `diaries/YYYY-MM-DD.md` 与每日日志 | 助手可自动追加，但必须带出处（会话、连接器、时间）。新日文件不存在则创建 |
| `about-you/` 核心五文件及用户放入该目录的档案 | 默认提出补丁（unified diff 或分段建议），用户确认后写入；设置可打开「自动接受低风险更新」（仅限追加不矛盾的句子，不得静默删除或覆盖矛盾事实） |
| 用户手改的 markdown | 用户编辑优先；保存走第 5.4 节冲突协议 |
| 系统只读摘要（日记精选、未来的健康汇总、录音摘要） | 可重新生成，UI 不得当普通文件乱改；用「由活页生成，不可直接编辑」这类**原创**标注，禁止复制 Today 原文 |
| 夜间整理 / reflect | **v1 之后的钩子**：预留 `packages/core` 的 `ReflectJob` 接口与设置项「整理时刻」，MVP 不跑。不要把「约凌晨 3 点」写成已证实的 Today 行为，也不要当活页的默认承诺 |
| 不信任来源（网页、群聊他人、工具原始输出） | 只许写入日记或 `uploads/`，并标记 provenance；不得直接升入核心画像 |

Provenance 枚举（写入活动流与日记）：`owner` | `agent` | `untrusted` | `system`。直接采用 OpenClaw 的分级原则，不必沿用其文件名。

上传：记忆导入单文件上限 **50 MB**，与校验、文案同一数字。聊天附件若在后续版本放开，上限 **100 MB**，同样文案与校验一致。视频、音频压缩包不得作为「关于你」原文件导入；音频走未来的 `recordings/` 管道。

### 5.4 编辑器冲突（实现合同）

Today 正式编辑器的交互属于「推断，待日后对照」。活页按下面合同实现，不假装这是实测结果：

1. 打开文件时记录 `revision`（git commit hash，或文件 mtime+sha256）。
2. 编辑器本地持有草稿；离开路由不丢草稿（按文件路径存在 `data/` 或 `localStorage`，并在重新打开时提示「有未保存草稿」）。
3. 保存时若磁盘 `revision` 与打开时不同：不得静默覆盖。弹出冲突窗：查看磁盘最新版、查看差异、用我的草稿覆盖、丢弃草稿。
4. 保存成功必须再读回磁盘并更新 `revision`；若写后校验失败，明确要求用户再点一次保存，不得假装成功。
5. 只读文件（系统摘要、`ABOUT.md` 派生视图）隐藏「保存」，只提供「编辑源文件」或「重新生成」。
6. 外部（VS Code 等）直接改 `~/Huoye/memory` 是一等公民：文件树做保守的 mtime 监视，冲突走同一套协议。

活动流：有 git 则把 commit 作成 `MemoryActivity`（cursor 分页）；无 git 则把每次成功保存的快照写入 `memory/activities/`。活动流要能回答「谁、在何时、改了哪个文件」。

### 5.5 检索（索引层）

MVP：SQLite FTS5（unicode61）检索文件标题与正文，结果回链到文件路径与行。关闭或删 `index.sqlite` 只影响搜索，不影响文件。

v1：可选嵌入索引；查询默认「关键词 + 可选向量」；评分不得覆盖用户置顶与核心画像的注入优先级。核心画像在会话开始按 token 预算注入；日记默认不整文件进提示，靠检索取回（与 OpenClaw / CowAgent 的分层一致）。

### 5.6 夜间整理钩子（后做，但接口现在就要留）

```ts
interface ReflectJob {
  id: string;
  scheduledFor: string;          // ISO，用户时区
  status: "idle" | "running" | "completed" | "failed";
  reportPath?: string;           // 人可读整理报告，建议 memory/activities/reflect-YYYY-MM-DD.md
  proposedPatches: MemoryPatch[];
}
```

MVP 只定义类型与「未启用」设置项。开启后：只生成补丁与报告，核心文件仍受第 5.3 节约束。

---

## 6. 数据模型（TypeScript 合同）

所有类型放在 `@huoye/schema`，用 zod 定义并 `z.infer`。标识符用 ULID 或 `prefix_` + 随机串（`mem_`、`tsk_`、`cnf_`、`use_`、`cht_`）。时间一律 ISO 8601，带时区偏移。

### 6.1 记忆

```ts
type MemoryKind = "about_you" | "diary" | "upload" | "system_summary" | "other";
type Provenance = "owner" | "agent" | "untrusted" | "system";

interface MemoryFile {
  id: string;
  relativePath: string;          // 相对 memory/，POSIX 分隔符，禁止 ..
  title: string;
  kind: MemoryKind;
  pinned: boolean;
  readonly: boolean;
  content: string;               // 含或不含 frontmatter，API 需说明；建议正文与 frontmatter 分离返回
  frontmatter: Record<string, unknown>;
  revision: string;              // git hash 或 sha256
  bytes: number;
  createdAt: string;
  updatedAt: string;
}

interface MemoryTreeNode {
  type: "dir" | "file";
  name: string;
  relativePath: string;
  kind?: MemoryKind;
  pinned?: boolean;
  readonly?: boolean;
  children?: MemoryTreeNode[];
}

interface MemoryPatch {
  id: string;
  targetPath: string;
  baseRevision: string;
  diff: string;                  // unified diff
  summary: string;
  provenance: Provenance;
  sourceRef?: string;            // 如 chat:c_xxx、connector:feishu
  status: "proposed" | "accepted" | "rejected" | "expired";
  createdAt: string;
}

interface MemoryActivity {
  id: string;
  at: string;
  actor: Provenance;
  op: "create" | "update" | "delete" | "rename" | "pin" | "upload" | "patch_accepted" | "reflect";
  path: string;
  revision?: string;
  message: string;
  cursor: string;                // 分页
}

interface MemorySearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
}
```

### 6.2 任务

Today 把任务分成 **on-demand（即时）** 与 **scheduled（定时）**，并用 run-events 做只追加运行日志——这是静态分析结论。下列状态机是活页自己的实现合同，标为「推断后自定，待日后对照」。

```ts
type TaskKind = "on_demand" | "scheduled";
type TaskStatus =
  | "draft"
  | "pending_confirmation"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "scheduled";                 // 定时任务在等待下次触发

interface TaskSchedule {
  kind: "once" | "cron";
  runAt?: string;                // once
  cron?: string;                 // cron，五或六位，时区用 timezone
  timezone: string;              // 默认 Asia/Shanghai
  enabled: boolean;
  nextRunAt?: string;            // 下次到期；创建时写入，跑完后推进
}

// 错过策略（活页自定）：服务器停机期间到期的任务，恢复后补跑一次。
// 周期任务随后把 nextRunAt 推到「现在之后」的下一档，不会把中间错过的每一档都补上。

interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  instruction: string;           // 给助手的任务说明
  status: TaskStatus;
  schedule?: TaskSchedule;
  confirmationIds: string[];
  chatId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
}

interface TaskRunEvent {
  id: string;
  taskId: string;
  at: string;
  type: "log" | "tool_call" | "confirmation" | "status" | "model";
  message: string;
  payload?: Record<string, unknown>;
}
```

MVP：可创建即时任务并手动「运行」（走 agent 循环或先把说明发进聊天）；运行中产生的对外写进入确认队列，任务进入 `pending_confirmation`，全部批准或用户取消后再结束。定时任务可创建但 MVP 可不触发。

Routines / Ongoing / 推荐任务：v1 再做，schema 里不要预先伪造未设计的字段。

### 6.3 确认

```ts
type ConfirmationRisk = "low" | "medium" | "high";
type ConfirmationStatus = "pending" | "approved" | "rejected" | "edited_approved" | "expired";

interface ConfirmationRequest {
  id: string;
  createdAt: string;
  expiresAt?: string;            // 默认 24h
  status: ConfirmationStatus;
  risk: ConfirmationRisk;
  action: string;                // 如 "feishu.message.send"、"fs.write"、"shell.execute"
  target: string;                // 人可读目标：聊天、文件路径、日历事件
  summary: string;
  preview: string;               // 将要发出的正文、命令、diff
  editable: boolean;             // 允许用户改 preview 再批准
  toolPayload: Record<string, unknown>;  // 批准后原样或经编辑后执行
  taskId?: string;
  chatId?: string;
  connectorId?: string;
}
```

### 6.4 用量与审计

```ts
type UsagePurpose =
  | "conversation"
  | "task"
  | "scheduled_task"
  | "brief"
  | "memory_update"
  | "reflect"
  | "other";

interface UsageEvent {
  id: string;
  at: string;
  provider: string;              // 如 openai-compatible、mock
  model: string;
  purpose: UsagePurpose;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  unitCostInUsd?: number;        // 用户配置的估算单价，可空
  estimatedCostUsd?: number;
  source: "byok" | "relay";      // MVP 只有 byok
  chatId?: string;
  taskId?: string;
}

interface AuditEvent {
  id: string;
  at: string;
  actor: "user" | "agent" | "system";
  type: string;                  // 如 model.call、memory.read、connector.read、confirmation.approved
  summary: string;
  refs?: string[];               // 文件路径、邮件 id、确认 id
  metadata?: Record<string, unknown>;  // 不得写入完整密钥
}
```

设置里的用量页展示按日 / 按月 / 按 purpose / 按模型的汇总。CC Switch **本身不卖 token**，活页的 MVP 也只做估算，不收费。

### 6.5 设置、模型、会话（MVP 最小集）

```ts
interface ModelProviderConfig {
  id: string;
  type: "openai_compatible" | "mock";
  name: string;
  baseUrl?: string;
  modelId: string;
  hasApiKey: boolean;            // 对外只暴露是否已配置
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
}

type Proactivity = "off" | "anchors_only" | "calendar_changes" | "allowed_news";

interface Settings {
  language: "zh-CN" | "en";
  timezone: string;
  displayName: string;           // 用户称呼
  assistantName: string;         // 默认「叶」
  proactivity: Proactivity;      // MVP 先存值，行为可部分生效（off 则不自动生成简报）
  autoAcceptLowRiskMemoryPatches: boolean;  // 默认 false
  memoryReflectEnabled: boolean; // 默认 false
  defaultProviderId?: string;
  providers: ModelProviderConfig[];
}

interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatMessage {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  usageEventId?: string;
}
```

---

## 7. 确认后写入的权限模型

原则：**读可审计，写要确认；本机高危能力默认关，且绝不能零提示接通。** Linux 上手看到 Today 对 Desktop / shell「一点 Connect 就生效、Other Files 实际映射家目录」——活页禁止模仿这一点。

### 7.1 能力范围

```ts
type PermissionScope =
  | "memory.diary.append"
  | "memory.about_you.patch"
  | "memory.core.auto_write"     // 仅当用户打开「自动接受低风险更新」
  | "fs.read"                    // 必须绑定具体 rootId
  | "fs.write"
  | "shell.execute"
  | "clipboard.read"
  | "clipboard.write"
  | "computer.control"
  | `connector.read:${string}`
  | `connector.write:${string}`
  | `channel.send:${string}`;
```

授权记录绑定 `rootId` 或连接器 id，不能是「打开了文件能力 = 整个家目录」。

### 7.2 决策表

| 动作 | 默认 | 备注 |
| --- | --- | --- |
| 读 `memory/`、在预算内注入核心画像 | 允许 | 记审计 |
| 追加当天日记 | 允许（带出处） | 可在设置关掉 |
| 对 `about-you/` 提出补丁 | 允许提出，默认不写盘 | 用户确认或低风险自动接受 |
| 读用户明确授权的文件夹 | 允许 | 文件夹由系统选择器添加，可随时撤 |
| 写 `memory/` 之外的任何文件 | 先确认 | 包括授权文件夹内的写 |
| 发邮件 / IM / 日历修改 / 工单 / 频道消息 | 先确认 | preview 必须可编辑 |
| shell、电脑控制、剪贴板写 | 默认关；开启要单独同意框，列清风险；每次执行仍先确认 | MVP 不做真实执行，只把权限框与确认队列做出来也可 |
| 把家目录、`/`、ssh 密钥目录当 root | **禁止作为默认选项** | 若用户执意添加家目录，必须二次点名确认 |

### 7.3 确认中心 UX

- 聊天和任务里出现待确认卡片：摘要、目标、可展开的正文 / diff / 命令、批准、拒绝、编辑后批准。
- 设置 → 待确认，列出历史。
- 过期未处理视为拒绝，不得补执行。
- 连续同类低风险动作也不得「第一次批准后自动放行」，除非用户在该确认上显式勾选「以后对这个连接器的这类动作不再询问」（v1，MVP 可只把复选框禁用并注明未就绪）。

### 7.4 本机连接器（相对 Today 的纠正）

- Desktop / Downloads / Documents：只在对应目录**真实存在**且用户点选后才标「已连接」。目录不存在就说已连接，禁止。
- 「其他文件夹」：打开系统选择器，用户多选目录。禁止默默映射 `$HOME`。
- Command Line / Operate Computer：必须先出能力说明与风险，再授权；授权与执行分离。撤销授权必须同时清掉本地 granted 标记，不能出现「UI 已断开、磁盘仍 granted」的陷阱。

---

## 8. 连接器与通道

不要把「连接器」和「通道」混成一张表。

- **连接器（Connectors）**：日历、邮箱、云盘、文档、代码托管、本地文件夹等。读写第三方数据。
- **通道（Channels）**：让用户在飞书 / 钉钉 / 微信等聊天工具里跟活页对话。微信按通道做，不塞进云应用门闸。

### 8.1 引导

顺序建议：欢迎与隐私说明（原创文案）→ 用户称呼（可跳过）→ 助手名与头像（可跳过，默认「叶」）→ 可选的记忆预览（根据已填称呼生成一页很短的 `profile.md` 草稿，可跳过）→ 可选连接本地文件夹或以后再连云应用（门槛 = 0）→ **直接进入五栏应用**。

禁止：为继续而强制连接 ≥1 或 ≥2 个云应用；禁止套餐 / 试用墙；禁止把飞书排除在产品一等体验之外（设置与目录里从第一天就有条目，即便 MVP 只是「即将接入」）。

### 8.2 实现分期

| 阶段 | 连接器 / 通道 |
| --- | --- |
| MVP | 本地自选文件夹（只读为主，写要确认）；连接器与通道设置页空态诚实 |
| v1 | 飞书 / Lark、钉钉：官方 SDK。微信：参考腾讯维护的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT，iLink）。日历可先做 CalDAV 或系统日历。邮件可先做 IMAP 只读 + 需确认的 SMTP |
| 更后 | GitHub、Notion 等按官方 OAuth；MCP 自定义连接器；健康类数据源。Discord / Telegram 可作为国际通道补齐 |

飞书、钉钉、微信在设置里的标签从第一天就是「一等」，不是「国际目录的附录」。Today 国际包引导白名单没有这三项（静态分析与上手均确认门闸不见它们；设置里的真实 flag 仍属「推断，待日后对照」）。活页不复制那份 13 项白名单。

### 8.3 连接器接口（自研，不换皮 OpenClaw / CowAgent 产品壳）

```ts
interface Connector {
  id: string;
  name: string;
  kind: "cloud" | "local" | "channel";
  status: "not_connected" | "connected" | "error" | "coming_soon";
  capabilities: ("read" | "write" | "send")[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  // 写操作不得在 connect 内直接执行；必须返回 ConfirmationRequest 或经 core 的 tool bus
}
```

参考实现时只学官方 SDK 与 openclaw-weixin 的接入方式，不整仓 fork。钉钉若需社区参考，也只参考协议层，并自行用官方 SDK 重写。

---

## 9. Token 计量与商业模式

对齐的是 **CC Switch 的精神，不是 CC Switch 的产品形态**。CC Switch（`farion1231/cc-switch`，MIT）是免费的供应商切换与用量估算工具，**本身不向用户卖 token**。活页同样：

1. **软件 MIT，免费使用全部核心功能。** 没有试用墙，没有「不付费就进不了聊天 / 记忆 / 任务」。
2. **默认 BYOK。** 用户自备 OpenAI 兼容接口的密钥与额度；费用发生在用户自己的模型渠道。
3. **用量页只做记录与估算**（`UsageEvent`），便于对照账单。单价由用户填，不假装是官方报价。
4. **可选中转是后做能力**，不是 MVP。若以后提供：必须与 BYOK 并存、可关；按计量收费；不得因此锁导出、删数据或关核心功能。中转不是「Pro 订阅墙」的换皮。
5. 导出记忆、删除工作区、撤回授权，永远不设付费门槛。

设置文案必须写清：活页不售卖模型额度；你看到的费用是根据你自己填写的单价估算的。

---

## 10. UI 信息架构与视觉

### 10.1 五个表面

路由（不要照抄 Today 会 404 的别名）：

| 表面 | 路由 | 职责 |
| --- | --- | --- |
| 聊天 | `/chat`、`/chat/:id` | 对话、待确认卡片、任务回写入口 |
| 今天 | `/today`（应用默认落地，也作 `/`） | 日期、简报、今日任务、占位的健康 / 录音卡 |
| 任务 | `/tasks`、`/tasks/new`、`/tasks/:id` | 即时 / 定时分段，状态可见 |
| 记忆 | `/memories`、`/memories/*` | 关于你一览、文件树、编辑器、日记入口 |
| 助手档案 | `/assistant` | 头像、名字、`AGENT.md` 摘要、与用户的起始日期、日记入口 |

设置是一等页面：`/settings`，并在所有表面提供齿轮入口。子路由固定为：

`/settings/models`、`/settings/connectors`、`/settings/channels`、`/settings/skills`、`/settings/usage`、`/settings/permissions`、`/settings/proactivity`、`/settings/workspace`、`/settings/export`。

不要做 `/settings-panel` 这种只有内部才知道的路径。日记也可从 `/memories/diaries/:date` 进入。健康 / 录音路由可先做 `/memories/health`、`/memories/recordings` 的「未就绪」页。

每个表面底部（移动）或页底（桌面）保留输入条，占位符按表面变化（用原创中文，例如「和叶聊聊…」「整理今天…」「交待一项任务…」「告诉我更多关于你的事…」）。任务与记忆必须能钻回聊天，聊天能钻回任务。

### 10.2 结构上的视觉语言（学气质，不抄品牌）

用结构词描述，不使用 Today 的 wordmark、冒号图标或 April / Spark 资产：

- 全屏竖向氛围渐变：顶部浅雾蓝，底部暖杏 / 桃，避免冷白工具风
- 卡片：大圆角、半透明玻璃（浅白底 + 极淡边 + 内侧高光 + 冷灰轻阴影）
- 主文字偏暖暗灰，主按钮为实心亮蓝胶囊
- 底部 Tab 为浅色胶囊，选中略深
- 聊天：中轴时间、用户气泡偏灰、助手气泡白底圆角；任务与确认以嵌入卡片出现
- 记忆：上方「关于你」故事卡，下方文件夹网格；健康文件夹以后才用特殊指标模板
- 任务列表用「今天 / 昨天」分组，条目之间留白而不是分割线
- 主动克制：少通知、短简报、其余可折叠

暗色主题：MVP 可先只做浅色，但颜色 token 必须集中在 `@huoye/ui`，不要写死在页面里。

### 10.3 字体（只用许可证清楚的开源字体）

禁止把 `todayai-research/assets/fonts/` 里从 Today 站点下下来的 woff2（含子集化的 Figtree / Sentient）拷进产品仓。

| 角色 | 选定字体 | 许可证 | 说明 |
| --- | --- | --- | --- |
| UI 无衬线（拉丁） | **Figtree** | SIL OFL 1.1 | 用官方 npm 包 `@fontsource-variable/figtree`（可变字体 300–900），在 `apps/web/src/index.css` 里 `@import`。只用官方包，不碰 Today 站点上的子集文件 |
| 中文 | **Noto Sans SC** | SIL OFL 1.1（Google） | 用官方 npm 包 `@fontsource-variable/noto-sans-sc`，随包发布；系统 PingFang / Noto Sans CJK SC 只作兜底。中文先排好，混排才不散 |
| 展示衬线（仅笔记编辑器长文正文） | **Source Serif 4** | SIL OFL 1.1（Adobe） | Sentient 为 Fontshare 上的 ITF Free Font License（闭源免费字体），限制再分发、子集化与二次提供，**开源仓不得嵌入** |
| 等宽（代码、diff、命令预览） | **Geist Mono** | SIL OFL 1.1（Vercel） | 允许，从官方取得 |
| 手写 | 默认不用 | — | 营销页若需要，只用 Google Fonts 上 OFL 的字体并自行下载，不进应用主界面 |

中文规则：中文标题、问候、日期、说明一律 `letter-spacing: 0`（最多 +0.01em），禁止负字距，禁止把 0.08em 这类西文小标签字距套到中文日期上；眉题用字号、字重、灰阶分层。不要嵌入来源不明的「日式手写」或 Today 文案里出现过的商业中文字体。

---

## 11. 比 Today 更好、且必须能落地的清单

这些不是口号，每一条都要能在代码里验收：

1. **可跳过的认证与引导**：不强制云账号；本地即可用。
2. **核心应用无付费墙**：聊天、今天、任务、记忆、设置在安装后即可用。
3. **飞书 / 钉钉 / 微信一等**：设置与信息架构从第一天露出；v1 用官方 SDK / 腾讯 iLink 插件路径落地。
4. **可自托管、默认本地**：记忆与配置在 `$HUOYE_HOME`；服务默认只绑 127.0.0.1。
5. **开放 Skills / MCP**：自定义 MCP 与本地 skill 目录是一等能力，不是隐藏开关。
6. **可调的主动性**：`off` / `anchors_only` / `calendar_changes` / `allowed_news` 出现在设置里，且 `off` 真正安静。
7. **审计日志**：模型调用、读了哪些记忆文件或连接器对象、为什么提出建议，用户可查。
8. **导出与删除永不设门槛**：一键导出记忆树与设置（不含密钥明文的选项要有）；删除工作区不要求订阅。
9. **Windows / Linux 与 macOS 对等**：本机能力不先做再砍；Linux 不是二等公民。
10. **更诚实的本机授权**：不默认家目录、不零提示授予 shell、断开即清除授权标记。
11. **矛盾记忆不静默覆盖**：核心画像冲突标待核。
12. **中文先写对**：默认 zh-CN，语气短句、口语、克制，但不使用 Today 营销原句。

---

## 12. 第一个 Claude Code 里程碑（脚手架 PR）

目标：在全新空目录生成上一节的 monorepo，使 `pnpm dev` 在本机跑出一个**可点、可聊、可改记忆、无付费墙**的活页 MVP 骨架。不包含 Electron 安装包、真实飞书登录或向量索引。

### 12.1 命令（写进根 README，必须可复制）

```bash
corepack enable
pnpm install
pnpm dev          # 并行启动 API :8787 与 Web :5173
pnpm test         # vitest，全部绿
pnpm typecheck
pnpm lint
```

可选：`HUOYE_HOME=/tmp/huoye-dev pnpm dev` 用临时工作区。`pnpm dev` 结束时打印两个 URL，并在 `$HUOYE_HOME` 尚不存在时生成第 3.1 / 5.1 节的目录与种子文件。

### 12.2 本里程碑必须出现的包与脚本

根 `package.json` 的 `scripts`：`dev`、`test`、`typecheck`、`lint`。`dev` 用 `concurrently` 或 pnpm filter 同时起 `apps/server` 与 `apps/web`。Web 的 Vite `server.proxy` 把 `/api` 指到 `8787`。

`apps/desktop` 可以只有 README（说明下一里程碑才打包），但 workspace 里要有这个目录，避免以后改名。

### 12.3 API 最小面（都是本地 Hono，前缀 `/api`）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/health` | `{ ok: true, name: "huoye" }` |
| GET/PUT | `/api/settings` | 读设置；PUT 不得用请求体回写完整密钥。单独 `PUT /api/settings/providers/:id/key` 写密钥 |
| GET | `/api/memory/tree` | 文件树 |
| GET | `/api/memory/about-you` | 按固定顺序拼接 |
| GET/PUT | `/api/memory/file?path=` | GET 返回 `MemoryFile`；PUT 必须带 `expectedRevision`，冲突返回 409 与双方摘要 |
| POST | `/api/memory/mkdir`、`/rename`、`/pin` | 变更树 |
| DELETE | `/api/memory/file?path=` | `profile.md` / `identity.md` / `lifestyle.md` / `work.md` / `devices.md` 五个核心文件不得删除、不得改名（路径稳定）；只允许清空正文。用户自建文件可删可改名 |
| GET | `/api/memory/activities` | cursor 分页 |
| GET | `/api/memory/search?q=` | FTS，可先做朴素扫描但要预留同一响应形状 |
| GET/POST | `/api/chats`、`/api/chats/:id/messages` | 列表与历史 |
| POST | `/api/chats/:id/messages/stream` | SSE 流式回复；把 token 记入 UsageEvent |
| GET/POST | `/api/tasks` | 列表与创建 |
| GET | `/api/tasks/:id` | 详情 + run events |
| POST | `/api/tasks/:id/run`、`/cancel` | 运行 / 取消 |
| GET | `/api/confirmations` | 待处理在前 |
| POST | `/api/confirmations/:id/approve`、`/reject`、`/edit-and-approve` | 状态机 |
| GET | `/api/usage/summary`、`/api/usage/events` | 用量 |
| GET | `/api/audit` | 审计分页 |
| GET | `/api/export/memory.zip` | 打包 `memory/`，永不收费 |

所有写接口只听 127.0.0.1。路径参数必须做穿越检查。

### 12.4 UI 完成标准（`pnpm dev` 打开后人工 5 分钟能做完）

1. `/` 落到 Today：能看到日期、问候、今日任务空态、简报区（可点生成；无密钥则提示去设置）、健康 / 录音卡写明「未就绪」。没有套餐弹窗。
2. 五个导航都能进，刷新不丢路由。
3. 设置 → 模型：可添加 `mock`（已内置）或 OpenAI 兼容供应商并保存密钥；用量页能打开（初始为零）。
4. 聊天：用 mock provider 发送「你好」，流式收到回复，会话出现在侧栏。用真实密钥（若有）同样路径可用，但测试默认走 mock。
5. 记忆：看见五个核心文件与空日记目录；打开 `profile.md`，编辑、保存、刷新仍在；制造冲突（保存前在磁盘改同一文件）会看到冲突窗而不是覆盖。
6. 任务：新建一个即时任务并出现在列表；点运行至少产生一条 run event（mock 即可）。
7. 确认中心：fixtures 提供一条「拟发送消息」待确认，批准 / 拒绝状态变化正确。
8. 设置 → 导出：能下载 zip。设置 → 工作区：能看到 `$HUOYE_HOME` 路径。
9. 引导在首次启动可走完或跳过；跳过之后仍进入应用。
10. 页面没有 Today / Spark / April 的商标、图标或营销句。

### 12.5 测试完成标准（`pnpm test` 必须覆盖）

- `packages/memory`：创建种子树；拼接 ABOUT 的顺序；拒绝路径穿越；`expectedRevision` 冲突；不得删除五个核心文件名；日记追加带出处。
- `packages/core`：对外写必须生成 pending confirmation；未批准不得执行；过期视为拒绝。
- `packages/metering`：一次 mock 调用写出 `UsageEvent`，汇总数字正确；序列化日志不含密钥。
- `packages/schema`：zod 对合法 / 非法载荷。
- `apps/server`：health、文件 PUT 409、export zip 含 `about-you/profile.md`。

不要求本里程碑有 Playwright。有最好，但不是「完成」门槛。

### 12.6 README 必须写清的产品事实

- 一句话定位、MIT、默认目录、`pnpm dev`
- 软件免费，BYOK；CC Switch 只是精神同类，活页并不卖 token
- 飞书 / 钉钉 / 微信是路线图上的一等通道，本里程碑尚未接通
- 与 Today 的关系：学信息架构，不是官方产品，也尚未用付费 App 对照过简报 / 编辑器细节

### 12.7 本里程碑「不要做」

不要做安装程序、自动更新、错误追踪 SaaS、登录云、付费墙组件、把调研仓的字体和截图拷进来、去连 Today API、去实现完整电脑控制。

---

## 13. 本地 API 与 Agent 循环的补充约定

- 系统提示由三块拼接：`AGENT.md`（截断到预算）、`about-you` 非空核心文件（按固定顺序、按预算截断）、最近对话。日记与 uploads 只通过检索工具进入。
- 助手若要改核心画像，只能调用 `memory.propose_patch`，不能直接 `fs.write`。
- 助手若要对外写，只能调用会创建 `ConfirmationRequest` 的工具；工具在批准前返回「已提交确认」，而不是成功。
- Mock provider 用于测试与无密钥演示，输出可确定的短句，并仍写 UsageEvent（token 可用近似计数）。
- 日志与审计默认不过网。若以后加可选遥测，必须默认关，且不含记忆正文与密钥。

---

## 14. 文档与调研的关系

实现仓不要依赖 `/workspace/todayai-research` 才能编译。本规格进入实现仓的 `docs/IMPLEMENTATION-SPEC.md` 即可。调研里的截图、字体、客户端解包只给人类对照信息架构，不进产品构建。

若日后进入 Today 正式 App，应回写 `PRODUCT-MECHANISM.md` 与本规格的「推断」条目，而不是在未验证前改第 5–7 节已拍板的活页行为——除非发现我们的合同有害或不清，再另开变更。

---

## 15. 主要引用

- 本目录 `OPEN-SOURCE-MEMORY.md`、`PRODUCT-MECHANISM.md`、`TODAYAI-TEARDOWN.md`、`hands-on/app/REPORT.md`
- OpenClaw 记忆：https://docs.openclaw.ai/concepts/memory-architecture
- CowAgent 记忆：https://docs.cowagent.ai/memory
- Letta MemFS：https://docs.letta.com/concepts/memfs/index.md
- 腾讯微信通道：https://github.com/Tencent/openclaw-weixin
- CC Switch：https://github.com/farion1231/cc-switch
- Figtree：https://github.com/google/fonts/tree/main/ofl/figtree（SIL OFL 1.1）
- Noto Sans SC：https://github.com/notofonts/noto-cjk（SIL OFL 1.1）
- Source Serif 4：https://github.com/adobe-fonts/source-serif（SIL OFL 1.1）
- Geist Mono：https://github.com/vercel/geist-font（SIL OFL 1.1）
- Sentient 许可证说明（为何不用）：https://www.fontshare.com/fonts/sentient 、https://www.fontshare.com/licenses/itf-free-font-license
