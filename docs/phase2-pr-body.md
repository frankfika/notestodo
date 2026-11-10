## 背景

`worktree-mindmap-finalize` 收尾 Phase2 脑图 F-02 / F-09，并把 UX 大改 cherry-pick（`573ae14`）带上。

上游交接（`docs/minimax-cloud-handoff-mindmap.md`）记录的现象是：`web/tests/mindmap-shortcuts.spec.ts` 大面积超时红，怀疑是选择器 / 画布就绪 / 默认图不对。**重跑后这三个怀疑全部证伪** —— 真实原因是页面被 ErrorBoundary 吞掉，`mindmap-canvas` 从未渲染。

## 真实根因（3 个产品 bug）

| # | 缺陷 | 影响 | 是否本分支引入 |
|---|---|---|---|
| 4 | 画布对任何 `todos` 变化都 `refresh` 重建 DOM | 与本图无关的 DB 变更也会重建画布，吞掉进行中的双击（偶发红） | 是 |
| 1 | `InboxSidebar` 把会**写库**的 `ensureInboxMap()` 放进 `useLiveQuery` → Dexie 抛 `ReadOnly: Readwrite transaction in liveQuery context` | 整个任务页崩溃。新装用户一开 `mindmap_tasks` 开关即崩 | 否 —— 来自 main 的 `8690c87` |
| 2 | `MindmapCanvas` 的 ME `operation` 监听器闭包捕获**初始空 `todos`**（effect deps 只有 `[rootId]`）→ `byId` 恒空 | `removeNodes` / `moveNodes*` 补丁被整段跳过，**删除 / 提升 / 降低都不落库** | 是 |
| 3 | ME 的 `findEle()` 找不到节点时是**抛异常**而非返回 null | 节点完成 / 删除后折进折叠的「已完成」组 → 画布崩溃 → 整页 ⌘Z 撤销失灵 | 是 |

## 改了什么

**产品（3 处）**

- `web/src/lib/mindmap/mapRoots.ts`：新增只读的 `findInboxMap()`
- `web/src/lib/mindmap/inboxCapture.ts`：`listInboxCaptures()` 改为只读
- `web/src/pages/todos/InboxSidebar.tsx`：querier 全部只读，`ensureInboxMap()` 挪到 `useEffect`
- `web/src/lib/mindmap/mapRoots.ts`：`ensureInboxMap()` 的「找 + 建」改为**原子**（事务 + 单飞）。把创建挪进 effect 后，`StrictMode` 双挂载会并发调两次，原实现「先查再建」不原子 → **建出两个 Inbox 根图**（图库出现两个同名图根）。已加确定性回归测试
- `web/src/pages/todos/MindmapCanvas.tsx`：新增 `todosRef`（最新快照）+ `findEleSafe()`（兜住 ME 抛异常）
- `web/src/pages/todos/MindmapCanvas.tsx`：**渲染结果没变就别重画** —— 原实现里任何 `todos` 变化都会 `mei.refresh(data)` 重建整棵 ME DOM（清选中态、吞掉进行中的双击）；像「Inbox 根图创建」这种与本图无关的变更也会触发。改为对真正要渲染的那棵树取哈希，没变就跳过。副作用：shortcuts 全套 51.0s → 32.4s

**测试（4 处，均为测试自身写错，未改产品行为去迁就）**

- `mindmap-shortcuts.spec.ts`：`childIds('a')` 断言长度 1 → 改为基线相对（seed 里 `'c'` 本就是 `'a'` 的孩子）
- `mindmap-visual.spec.ts`：根节点字号断言 14px → 拆成「根 17px / 子节点 14px」（`mindmap.css:53-54` 有意给根节点 17px）
- `recording-multi.spec.ts`：`.rec-dot ~ span.font-mono.tabular-nums` 命中的是**侧栏墙上时钟**而非计时器 → 显式 scope 到 REC 计时器。详见下方「测试状态」
- `mindmap-inbox.spec.ts`：**新增** 1 例 —— Inbox 根图只建一个（StrictMode 双挂载不重复建）。已双向验证：原始实现稳定红（2 个），修复后稳定绿（1 个）

**文档**

- `docs/phase2-claude-acceptance.md`：事实 vs 假设、命令与数字、需求对比、风险
- `docs/phase2-pr-body.md`：本文件

## 这一轮追加：视觉 · 手感 · 完成记录与关联人

### 视觉 —— 「线条感太强，不像脑图」

根因是**形状**不是颜色：ME 默认次分支是「横 + 竖 + 横」的折线加长直线段，看着像流程图连接线。改用 ME **官方支持的主题扩展点** `theme.generateMainBranch` / `theme.generateSubBranch` 换成连续三次贝塞尔的**有机树枝**，主分支落子节点左缘、次分支落子节点左缘（ME 传的 `c*` 是 wrapper 几何，topic 左缘要 `cL + --node-gap-x`，取错线会从节点底下穿过去）。

> ⚠️ 这两个函数必须写在 **`theme`** 里，不能放构造函数顶层 —— ME 的 `setTheme` 会用 `theme.generateMainBranch || 默认实现` 覆盖掉顶层选项，**静默失效**。

同时画布自适应：1280 宽下整棵树缩放 0.865 放得下（原来右侧被裁掉 204px），1680/1920 下左右留白对称。

### 手感 —— 「不够丝滑」

三个真因：

1. 每次数据变化都 `refresh()` **重建整棵 DOM** → 加重绘前的「画布签名」比对（id + 标题 + 结构），一致就不重画。实测 Tab 加节点、双击改名后**原节点 DOM 不被重建**。
   （ME 的 `stringifyData()` 返回的是 **JSON 字符串**，取 `.nodeData` 恒为 `undefined` —— 得用 `getData()`）
2. 给画布加的 `transform` 过渡让**点击落点跟着动**，双击被拆开、「双击进入编辑」直接失效 → **撤掉过渡**。丝滑靠不重建 DOM，不靠让画布飘。
3. 教练提示改常驻 + `visibility/opacity` 过渡，从「啪」一下出现变成淡入。

外加：**双击进编辑**。ME v6 的 map 视图没有 dblclick 处理，靠「再点一次已选中的节点」，双击未选中节点常失灵（Tab 加完节点后双击改名就失灵）→ 补 `dblclick` → `editTopic`，并挡掉合成的「已完成 (N)」伪节点。

### 布局：画布优先（A + C 一起做）

画布之前被三条常驻面板挤到只剩 456px（1280 窗口下）。现在：

- **图库** → 画布左上角浮层（`◱ 当前图名 ▾`），切图 / 归档照旧
- **Inbox** → 画布左上角浮层（`↓ Inbox N`），捕获照旧
- **Today** → **从脑图 Tab 挪到「今天」页**（Today 槽位跟着走），脑图右上角只留 `☼ Today 3/5` 计数入口
- 画布宽度 456px → **1048px**，吃满整宽；「规划 / 执行分离」贯彻到底

顺带修掉一个脆弱实现：**⌘] / ⌘[ 切图原来靠 DOM 猜**（找 `<aside>` 里含「图库」的按钮替用户点），面板一改结构就断（直接暴露成用例红）。现在图库把「有序图 id + 选中回调」透进画布，键盘直接切。

### 完成记录 + 关联人 + 归档（F-10）

- `Todo.completed_at`：状态翻 `done` 自动记、翻回 `open` 清空。原来「完成」散在 **8 处**各自 update，谁也没记时间 → 收口到 `src/lib/todoStatus.ts` 的 `applyTodoStatus()`，UI 与外部 API 同一口径
- 人员目录（`src/lib/people.ts`，存 KV，**Dexie schema 仍 v10**）：**部门 → 小组 → 个人** 多层级，`internal` 标记 = **不对外**（默认名单不出现，勾「含内部」才看得到），`role: manager` 新建时默认内部；首次进入铺一份模拟人员，可随时增删改
- 关联人选择器（`src/components/AssigneePicker.tsx`）：任务行「⋯」菜单里，按层级分组 + 上溯路径 + 搜索 + 就地新建
- 串联：一行里同时看到「谁 · 什么时候 · 完成了什么」；脑图节点用 **ME 原生 `tags`** 渲染 `@李娜` / `完成 11/10`，样式压成最淡灰字
- **归档**：被否掉的事（投资A 黄了）→ `status=cancelled` + `archived_at`（复用已有的 cancelled 状态，不新增枚举；把只给「图根归档」用的 `archived_at` 泛化到任意待办）。从没完成过的，归档时补一个**结束时间**（`completed_at`）——「关闭了就得有时间」。任务行「⋯」里可归档（带撤销），顶部新增**「已归档」**筛选页签看记录，脑图上直接消失
- **顺带修掉**：`purgeIneligibleSlots()` 写好了却从没被调用 → 完成 / 归档的条目一直占着 Today 的坑；挂到 `applyTodoStatus()`（状态变化的唯一出口）上
- 新增 `web/tests/todo-completion-people.spec.ts`（10 例）、`web/tests/mindmap-layout.spec.ts`（4 例）

### 用了哪些开源能力

ME 的 `generateMainBranch` / `generateSubBranch`（官方扩展点）、ME 的节点 `tags`、Dexie KV。ME 官方生态里没有「有机树枝」插件；换 markmap / simple-mind-map 要重写 undo / Today / Inbox / 整套 E2E 集成，成本远大于收益 —— 留在 ME 上，只用它的扩展点。

## 测试状态

```bash
cd web && pnpm i && pnpm exec playwright install chromium
pnpm exec playwright test tests/mindmap-shortcuts.spec.ts --reporter=list   # 14 passed (32.4s)
pnpm exec playwright test tests/mindmap tests/local-api.spec.ts --reporter=list  # 44 passed (1.2m)
pnpm exec playwright test --reporter=list                                    # 170 passed / 1 skipped / 0 failed (10.5m)
pnpm exec tsc -b --noEmit                                                    # exit 0
```

| 项 | 修复前 | 修复后 |
|---|---|---|
| `mindmap-shortcuts.spec.ts` | ❌ **14 failed**（17.2–27.0s/例） | ✅ **14 passed**（~2.0s/例） |
| 脑图 + local-api（44 例） | — | ✅ **44 passed** |
| 全量套件（172 例） | — | ✅ **170 passed / 1 skipped**（skip 的是 `offline.spec.ts`，需生产构建，改动前既有行为） |
| `tsc -b --noEmit` | — | ✅ 绿 |

**没有 skip、没有 xfail、没有注释掉的用例。** 修复前每例都跑满 15s 超时，修复后每例约 2s。

> 另修掉一条**从未真正生效**的断言：`recording-multi` 用通用兄弟选择器 `.rec-dot ~ span.font-mono.tabular-nums` 读「elapsed 计时」，但侧栏品牌行的 `.rec-dot` 后面跟的是**当前墙上时钟**（`Sidebar.tsx:339,381,384`），在 DOM 里排在 `main` 之前，被 `.first()` 优先命中 —— 于是断言读到的是 `09:00`（= 540 秒）而非计时器，该用例因此长期 flaky、且**从未真正验证过跨录音的计时器隔离**。现已显式 scope 到 REC 计时器。

## 约束遵守情况

- ✅ `mindmap_tasks` 默认值仍为 `false`（`web/src/lib/features.ts` 未改动）
- ✅ Dexie 仍为 **v10**，schema 与依赖未降级
- ✅ 未新增任何 `zz-dbg*.spec.ts` 调试专用文件
- ✅ 未改动 `main`；所有改动都在 `worktree-mindmap-finalize` 上

## 待评审确认

1. **`573ae14`（全产品 UX 大改）改动面大于脑图** —— 全量 157 例已绿，但 UX 计划的交互细节未逐条人工走查，建议手动过一遍。
2. **视觉验收仍需人工** —— `web/tests/screenshots/visual-mindmap.png` 已存档供 HIG 复核；自动化只断言可断言的部分（字号层级 / 无盒子 / 画布跟令牌 / 教练提示非模态）。
3. 是否要把本 PR 拆成「3 个 bugfix」+「F-02/F-09 收尾」两个 PR —— 拆分点在 commit 边界，需你决定。

## 已知风险

- `listInboxCaptures()` 不再顺带创建 Inbox 根图（语义更正：GET 不应产生写入）；`POST /inbox/captures` 走 `captureToInbox()` 仍会自行创建 ✓
- Inbox 根图改为首次挂载 Inbox 侧栏时创建；其他调用方各自 `ensureInboxMap()`，不依赖侧栏 ✓
- `findEleSafe()` 兜底后行为从「整页崩溃」变为「选中态丢失」—— 取舍明确 ✓
- `todosRef` 存在极小的并发窗口（DB 写入 → 重渲染非同步），真人按键间隔远大于该窗口 ✓

完整验收报告见 [`docs/phase2-claude-acceptance.md`](docs/phase2-claude-acceptance.md)。
