# Phase2 脑图任务 · 发布验收

**仓库**: [frankfika/notestodo](https://github.com/frankfika/notestodo)  
**main 验收日**: 2026-11-09  
**依据**: [Phase1 验收](phase1-merge-acceptance.md)、[Phase2 计划](phase2-release-plan.md)

## Phase2 PR 合入顺序（全部 MERGED）

| 顺序 | PR | 分支 | 内容 |
|------|-----|------|------|
| 1 | [#27](https://github.com/frankfika/notestodo/pull/27) | `feat/mindmap-archive` | F-08 归档 + F-01 图库 |
| 2 | [#26](https://github.com/frankfika/notestodo/pull/26) | `feat/mindmap-undo` | R4 统一 ⌘Z 撤销栈 |
| 3 | [#30](https://github.com/frankfika/notestodo/pull/30) | `cursor/phase2-inbox-ba79` | F-04 Inbox 侧栏、F-05 Waiting、R1 教练 |
| 4 | [#31](https://github.com/frankfika/notestodo/pull/31) | `cursor/phase2-shortcuts-ba79` | F-02 烟测、快捷键语义、F-09 轻 polish |

Phase1 基线仍在 main：`#21`–`#25`（见 Phase1 报告）。

## 测试摘要（main @ 2026-11-09）

```bash
cd web && pnpm exec playwright install chromium   # 干净环境
cd web && pnpm typecheck
cd web && pnpm build
cd web && pnpm exec playwright test tests/mindmap-*.spec.ts tests/local-api.spec.ts
```

| 项 | 结果 |
|----|------|
| Playwright | **25 passed** |
| `typecheck` | 绿 |
| `build` | 绿 |

Spec 分布：local-api 4 + archive 2 + attach 1 + convert 6 + inbox 3 + leaf 1 + perf 1 + shortcuts 1 + today 3 + undo 3。

**Dexie 仍为 v10**，合入期间未降级 schema。

## F-01..F-10 与 R1–R6

| 项 | 状态 | 备注 |
|----|------|------|
| F-01 多图 + 一事一图 | **pass** | `MapLibraryPanel`、图切换；归档图可还原 |
| F-02 极致脑图编辑 | **partial** | ME6 + 写回 + 200 节点 convert 烟测；未做 UX-02 全快捷键/HIG 走查清单 |
| F-03 叶子 + Today | **pass** | TodayTray / swap / API |
| F-04 Inbox 捕获 | **pass** | `InboxSidebar` + `GET|POST /inbox/captures` |
| F-05 Waiting | **pass** | 画布 `· Waiting` + 样式；API `waiting_reason` |
| F-06 完成 + done-group | **pass** | Space 叶子完成；done-group |
| F-07 静默软顺序 | **pass** | `sort_order` |
| F-08 图归档 | **pass** | `mapArchive` + API + 踢 Today 槽 |
| F-09 Apple 极简视觉 | **partial** | `mindmap.css`、无巨型工具条；非全量 HIG 走查 |
| F-10 本地 / Dexie | **pass** | v10；见下 flag |
| R1 叶子规则可见可教 | **pass** | 非叶子 Space 无效；⌘T 不合规时内联 coach |
| R2 捕获默认一键 | **pass** | 会议确认流 + Inbox 捕获 |
| R3 单一编辑真相源 | **pass** | 大纲 `readOnly`（flag 开） |
| R4 失败可撤 | **pass** | 业务 ⌘Z：`undoStack`（ME 保持 `allowUndo: false`） |
| R5 不增画布噪点 | **pass** | 无徽章/模态轰炸 |
| R6 AI 不夺主 | **pass** | 无自动入槽/整图重画 |

**无 `gap` 硬项。** F-02、F-09 为 **partial**（体验清单，非阻塞发布）。

## `mindmap_tasks` flag

| 设置 | 值 |
|------|-----|
| 默认 | **`false`**（`web/src/lib/features.ts`） |
| 开启 | 设置 → 实验功能 → 脑图任务 |

未将默认改为 `true`；若需公开发布默认开启，需 Fang 书面确认（见下）。

## 公开发布试用步骤

1. 本地拉 main：
   ```bash
   cd /Users/fangchen/Baidu/GitHub/Notes\&ToDo && git pull origin main
   ```
2. `cd web && pnpm install && pnpm dev`（或 Tauri 包）。
3. 设置中打开 **脑图任务** 实验开关。
4. 任务页 → **脑图**：左侧图库选图，Inbox 侧栏捕获，Today 托盘 ⌘T 入槽。
5. 验证归档、⌘Z 撤销、会议落图（Phase1）。

## Dexie v10 注意

- 已上 main 的客户端 **不要回退** 旧版 app（否则 IndexedDB 版本冲突）。
- 新字段：`map_id`、`map_archived_at`、`waiting_reason` 等随 v10 迁移/backfill。

## 待 Fang 决策（非阻塞）

- 是否将 `mindmap_tasks` **默认改为 `true`** 对外试用。
- F-02 / F-09 全量 UX 清单是否纳入下一迭代。

## 结论

**main 可发布**：Phase2 四条线已合入，25 项 Playwright + typecheck + build 绿，`mindmap_tasks` 默认保持 **false**。
