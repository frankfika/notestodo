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

## 测试状态

```bash
cd web && pnpm i && pnpm exec playwright install chromium
pnpm exec playwright test tests/mindmap-shortcuts.spec.ts --reporter=list   # 14 passed (32.4s)
pnpm exec playwright test tests/mindmap tests/local-api.spec.ts --reporter=list  # 44 passed (1.2m)
pnpm exec playwright test --reporter=list                                    # 157 passed / 1 skipped / 0 failed (7.2m)
pnpm exec tsc -b --noEmit                                                    # exit 0
```

| 项 | 修复前 | 修复后 |
|---|---|---|
| `mindmap-shortcuts.spec.ts` | ❌ **14 failed**（17.2–27.0s/例） | ✅ **14 passed**（~2.0s/例） |
| 脑图 + local-api（44 例） | — | ✅ **44 passed** |
| 全量套件（158 例） | — | ✅ **157 passed / 1 skipped**（skip 的是 `offline.spec.ts`，需生产构建，改动前既有行为） |
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
