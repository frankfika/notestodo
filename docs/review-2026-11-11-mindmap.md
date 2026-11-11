# 脑图任务全量 Review 报告

范围：v0.6.2（a6ea2e9）至 acb16fc 的全部改动（UX 重做、mindmap 全特性、默认开启、两轮快速添加修复）。
日期：2026-11-11 · 基线状态：typecheck 绿，34+ 相关测试绿（acb16fc 时点）。

说明：本轮 8 个审查角度中，规范 / 复用 / 简化 / 效率 / 跨文件追踪 5 个已先行完成，
本次补跑逐行扫描、删除行为、根因深度 3 个角度，并对已完成角度点名的高价值候选逐条回代码验证。
先前 finder 未点名的次要候选（约 20 条）随中断的上下文丢失，本报告只收录**已在代码中逐条核实**的发现。

---

## P1 · 功能性 bug，建议尽快修

### 1. Waiting 节点在画布上改名会把「· Waiting」写进标题
- `convert.ts:88` 渲染时把显示串拼成 `${title} · Waiting`；`convert.ts:148-153` 的 finishEdit 把 ME 的显示串**无差别写回** `title`。
- 已核实 ME 行为（`MindElixir.js`）：编辑框预填显示串，blur 时 `a !== r && a !== ""` 即触发 finishEdit —— 用户对 Waiting 节点做任何改动，后缀就固化进数据，下次渲染变成「标题 · Waiting · Waiting」。
- 修：finishEdit 回写前剥离 ` · Waiting` 后缀；或渲染侧不拼字符串，改用 tag/style 表达 Waiting。

### 2. 画布「免重画签名」漏掉 metadata，assignee 等变更被吞
- `MindmapCanvas.tsx:178-187` 的 `treeSignature` 只含 id / topic / 结构。`assignee`（渲染为 `@人` chip）、`completed_at` 等只体现在 tags/metadata 的变更：hash 不同 → 进入签名比对 → 签名相同 → **跳过重画**，画布永久显示旧 chip。
- 触发路径：localApi PATCH 改关联人、其他页签改任务时画布开着。
- 修：签名并入 tags/metadata 的关键字段，或干脆只对「结构性操作后」做签名短路（见 P3-17）。

### 3. 列表 / 今天页删除不踢 Today 槽
- `todoRowOps.tsx:80-111` `softDeleteTreeWithUndo` 没有 `evictIfPresent` / `purgeIneligibleSlots`；purge 只挂在 `applyTodoStatus`（`todoStatus.ts:39`）。
- 后果：在「按时间」列表（脑图模式下仍可编辑，见 P2-10 相关）或「今天」页删掉一个已入槽任务 → 槽位被已删任务永久占用，只能靠手动 × 移除。
- 修：todos 的所有删除/软删路径统一挂槽位清扫（根因 R-B）。

### 4. 三套删除口径不一致，脑图删除永久丢失原状态
- 列表（`softDeleteTreeWithUndo`）：只置 `deleted_at`，tag bindings **硬删**；
- 脑图（`convert.ts:257-273`）：`deleted_at` + **status='cancelled'**，bindings 软删；
- localApi DELETE：同脑图。
- 后果：同一「删除」在「已归档」视图一边可见一边不可见；脑图删除后原 status 被覆盖，内存撤销栈之外（刷新页面）永久不可恢复。
- 修：统一为「只置 deleted_at，不动 status」，cancelled 留给「归档」语义。

### 5. localApi PATCH 移动节点不级联 map_id，map_id 可单独改
- `localApi.ts:372-388`：改 `parent_id` 时不更新自身及子树的 `map_id`（`convert.ts:225-231` 的画布移动会级联）；`map_id` 还可脱离 parent 单独 PATCH → 节点的树位置与图归属分裂。
- 修：PATCH parent_id 时复用画布同款级联逻辑；禁止单独改 map_id。

### 6. 存过 `mindmap_tasks:false` 的老用户被永久锁在旧版
- `features.ts:7` DEFAULT 已改 true，但 `{...DEFAULT, ...kv}` 救不了显式存过 false 的用户；`setFeature` 已无任何 UI 调用方（已全仓核实），localApi 的 9 处脑图端点对他们全部 404。
- 修：v10 迁移里顺带删掉 kv 的 features 行；或保留一个设置项。与 P3-15 二选一。

---

## P2 · 一致性与健壮性

### 7. 撤销栈全局单例：跨图串台 + 跨页失灵
- `undoStack.ts` 是模块级闭包栈，与 rootId / 页面无关。⌘Z 只在 TodosPage 脑图 Tab 绑定（`TodosPage.tsx:54-72`）：
  - 看着图 B 按 ⌘Z，撤销的可能是图 A 的操作（画面上毫无反馈）；
  - Today 页的「移出 / 替换 Today」push 了撤销项，但在 Today 页按 ⌘Z 无效，回脑图页撤销的是看不见的槽位操作。
- 编辑态还是双源：`MindmapCanvas.editingRef` + `undoStack.mindmapEditing`，异常路径下可分叉。
- 修：撤销栈按 rootId 分区 + 切图/卸载体清理；编辑态只留 ME bus 一个源。

### 8. Space 撤销丢 Today 槽
- `MindmapCanvas.tsx:494-496`：`pushTodoStatusUndo` 只回滚 status；完成触发的 `purgeIneligibleSlots` 把任务踢出槽位，撤销后槽位不回来。
- 修：Space 操作改走 `captureAndPushPatchUndo`（它带 todayBefore 快照），或状态撤销里附带槽位快照。

### 9. today_slots 读写全程无事务
- `addSlot / swapSlot / removeSlot / evictIfPresent / purgeIneligibleSlots` 全部是 getToday→setToday 读-改-写；`applyTodoStatus` 里的 purge 还是 fire-and-forget，与随后的 addSlot 可交错丢更新。
- `swapSlot`（`todaySlots.ts:57-72`）非原子：先删后加，若 add 失败（叶子恰好在期间变 ineligible）被换出的槽直接丢失。
- 修：槽位写操作收进 `db.transaction('rw', db.kv, …)` 或单飞串行化。

### 10. 新增入口残留旧逻辑：Today 页与列表仍建「无 map_id 的孤儿图根」
- acb16fc 只修了 TodosPage 快速添加一处。`TodayPage.tsx:120-127` 与 `todoRowOps.tsx:116-141`（createTodo/createSibling）仍建 `parent_id=null`、**无 map_id** 的任务 → 在图库里以「图根」身份出现（acb16fc 修的同款病，还有两处病灶）。
- 另：脑图模式下 TodosTree 只读、TodosList 却完全可编辑，「R3 单一编辑真相源」只执行了一半。
- 修：全部创建入口收口（根因 R-A）；明确列表在脑图模式下是只读还是二等编辑入口。

### 11. localApi DELETE 可删图根，无保护
- UI 拦截了根节点删除（`MindmapCanvas.tsx:578-581`），API 没有 —— 外部脚本一句 DELETE 就软删整张图（含全部子树），也没有 archiveMap 的 open_leaves 保护。
- 修：DELETE 遇到图根（parent_id=null）时拒绝或要求显式参数。

### 12. 撤销「添加节点」可制造孤儿
- `undoStack.ts:125-127`：撤销 add 只 `delete` 该节点；若撤销前用户已给它加了子节点，子节点 parent_id 悬空（树视图当孤儿提到顶，脑图里直接不可见）。
- 修：撤销 add 时软删/删除其子树，或禁止非叶子节点的添加撤销。

### 13. 画布移动的 sort_order 会撞号
- `convert.ts:223`：moveNodesBefore/After 取 `anchor ± 1`，与既有同级撞 sort_order 后顺序漂移；TodosTree 拖拽用的是前后邻居中点法 —— 两套排序口径。
- 修：统一用中点法（TodosTree 已是对的）。

### 14. 快速添加不进撤销栈
- TodosPage / TodayPage 的 addQuick 直接 `db.todos.add`，与画布操作「失败可撤（R4）」口径不一。

---

## P3 · 简化与效率

### 15. flag 恒真后的死分支
`setFeature`、TodosPage 非脑图分支、localApi 9 处 404 分支只服务于「存过 false 的老用户」。与 P1-6 合并决策：迁移 kv 后删死代码，或保留真开关。

### 16. 全表订阅重复挂
`db.todos.toArray()` 的 liveQuery 散在 MindmapCanvas、TodaySlots 三组件、TodayPage、TodosList、TodosTree、useOriginTitles 等近十处，任何任务变更全部重跑。建议收敛成一个共享 hook/store。

### 17. 免重画哈希本身不便宜
每次 todos 变更都全量 `todosToMindData` + `JSON.stringify` + 两次 `treeSignature` 遍历，只为省一次 refresh —— 树大时成本倒挂，还引入了 P1-2 的正确性 bug。建议换成「只有非本画布来源的变更才 refresh」（操作来源打标）。

### 18. 撤销快照全表 + 读写有窗口
`createUndoForPatches` 每次全量读 todos + getToday，且在应用事务**外**读取；apply 失败会留下指向未发生操作的撤销项。建议按 op 涉及子树定向快照，并把 capture 收进同一事务。

### 19. 六处手拼 Todo 字面量字段漂移
TodosPage.addQuick / TodayPage.addQuick / todoRowOps.createTodo·createSibling / captureToInbox / ensureInboxMap·ensureMeetingBranch / convert.newTask / localApi POST —— map_id、assignee、due_date、period 各给各的。这是复用角度的头号候选，根因即下述 R-A。

---

## 根因专题（角度 G）

- **R-A ·「创建任务」没有单一入口。** 两次快速添加事故（a1219f0 修错方向、acb16fc 返工）+ P2-10 的两处残留病灶，全部同根：归属策略（map_id / parent_id / 默认图）散在 7 个调用点各自决定。**收口为一个 `createTask(opts)` 领域函数**，画布、快速添加、Inbox、Today、会议、API 全部过它，字段默认值只有一份。
- **R-B · Today 槽位没有写路径收口。** 五个槽位函数各自读-改-写（P2-9），清扫只挂在状态变更一处（P1-3）。**把「todo 变更 → 槽位清扫」做成 todos 写路径的统一后置钩子**并事务化。
- **R-C · 撤销系统是架构上限，不是实现 bug。** 模块级闭包栈与 Dexie / 页面 / 图完全解耦，串台（P2-7）、丢槽（P2-8）、双源、刷新即丢都是它的症状。按 rootId 分区 + 页面卸载清理是低成本的正确性止血。

---

## 修复顺序建议

1. P1-1（Waiting 标题污染）+ P1-3（删除踢槽）：数据腐化类，越早修越少脏数据
2. P1-6（老用户锁定）：一行迁移
3. P1-2（签名漏 metadata）与 P3-17 合并重做
4. P1-4 / P1-5 / P2-11：删除与 API 口径统一
5. 根因 R-A / R-B 收口，顺手消掉 P2-10、P3-19
6. P2-7 / P2-8 / P2-12 撤销系统整改
