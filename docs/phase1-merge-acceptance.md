# Phase1 脑图任务 · 顺序合并验收

**仓库**: [frankfika/notestodo](https://github.com/frankfika/notestodo)  
**main 合并截止**: 2026-11-09（PR #21–#24 全部 MERGED）  
**验收依据**: [产品 canvas F/UX](https://cursor.com/canvas/store-2bb395cd-d76f-455a-bab4-1ec32bbd2b2d/049f996d-093f-47dc-b49a-79408ec18b45)、[技术实施方案 v3 §J](https://cursor.com/canvas/store-2bb395cd-d76f-455a-bab4-1ec32bbd2b2d/ec391385-aed8-4be4-b1e0-c1468edb925d)、项目 `docs/project-context.md`

## PR 最终状态

| PR | 分支 | 状态 | URL |
|----|------|------|-----|
| #21 A | `feat/mindmap-tasks-a-schema` | **MERGED** | https://github.com/frankfika/notestodo/pull/21 |
| #25 B | `feat/mindmap-tasks-b-canvas` | **MERGED** | https://github.com/frankfika/notestodo/pull/25 |
| #22 C | `feat/mindmap-tasks-c-today` | **MERGED** | https://github.com/frankfika/notestodo/pull/22 |
| #23 D | `feat/mindmap-tasks-d-meeting` | **MERGED** | https://github.com/frankfika/notestodo/pull/23 |
| #24 E | `feat/mindmap-tasks-e-api` | **MERGED** | https://github.com/frankfika/notestodo/pull/24 |

合并中在 **C** 额外提交 `fix: wire TodayTray and todayBridge into mindmap layout`（rebase 后接线缺失，已修再合）。

## 每步 Playwright 摘要

命令根目录：`cd web && pnpm exec playwright install chromium`（CI/干净环境需先装浏览器）

| 步骤 | merge 前相关 spec | 结果 | merge 后累计（到当前步） |
|------|-------------------|------|-------------------------|
| A | `mindmap-leaf.spec.ts`（1） | 1 passed | 1 passed |
| B | + `mindmap-convert.spec.ts`（6） | 7 passed；`pnpm typecheck` / `build` 绿 | 7 passed |
| C | + `mindmap-today.spec.ts`（3） | 10 passed；`typecheck` 绿 | 10 passed |
| D | + `mindmap-attach.spec.ts`（1） | 11 passed | 11 passed |
| E | + `local-api.spec.ts`（含 Today/completed，4） | **15 passed** | **15 passed**（main @ 合并 E 后复跑） |

**main 终态复跑（2026-11-09）**: `15 passed (5.2s)` — leaf 1 + convert 6 + today 3 + attach 1 + local-api 4。

## 需求对比缺口表（F-01..10 + Phase1）

对照产品 MVP 十条 + Phase1 技术边界（不做 sync maps / 双轨可写 / AI 自动入槽）。

| 项 | 状态 | 备注 |
|----|------|------|
| F-01 多图 + 一事一图 | **pass（trial）** | `map_id` v10、`listMapRoots`、图切换；轻量分类/归档库 UI 未做 |
| F-02 极致脑图编辑 | **partial** | Mind Elixir 6 + 写回；未覆盖 UX-02 全快捷键/200 节点 perf 验收 |
| F-03 叶子 + Today 容量换出 | **pass** | `todaySlots` + `TodayTray` + 满槽 `swapSlot`；单测 + API |
| F-04 Inbox 捕获归图 | **partial** | `ensureInboxMap` + API 可挂 Inbox；独立 Inbox 侧栏流未完整 |
| F-05 Waiting | **partial** | `waiting_reason` + `todayEligible`；画布标 Waiting UI 轻 |
| F-06 完成 + done-group | **pass** | `todosToMindData` 合成节点；Space 切换；踢槽 |
| F-07 静默软顺序 | **pass** | `sort_order`；无「建议稍后」徽章（符合 MVP 砍项） |
| F-08 图归档 | **gap** | 无归档 API/UI |
| F-09 Apple 极简视觉 | **partial** | `mindmap.css`、无巨型工具条；未做 UX-11 全量 HIG 走查 |
| F-10 本地优先 / Dexie 真相源 | **pass** | v10 未降级；`mindmap_tasks` 默认 **false** |

### UX 红线（R1–R6）摘要

| 红线 | 状态 | 备注 |
|------|------|------|
| R1 叶子规则可见可教 | **partial** | 非叶子无 Space 完成；⌘T 无内联「拆一步」教练 |
| R2 捕获默认一键 | **pass（会议）** | PendingTodos 主按钮 +「改位置…」披露；单测 attach |
| R3 单一编辑真相源 | **pass（flag 开）** | `TodosTree` `readOnly={mindmapEnabled}` |
| R4 失败可撤 | **gap** | ME `allowUndo: false`；入槽/完成无统一 ⌘Z 栈 |
| R5 不增画布噪点 | **pass** | 无徽章/彩带/日终模态 |
| R6 AI 不夺主 | **pass** | Phase1 未接自动入槽/整图重画 |

## main 能否开 flag 试用？

**可以（建议小范围内测）**：

- 设置 → 实验功能 → **脑图任务**（PR-E）；默认仍为 `false`。
- 试用前本地：`cd /Users/fangchen/Baidu/GitHub/Notes\&ToDo && git pull origin main`
- 已知 trial 缺口：F-08 归档、R1/R4 体验、F-02 perf/HIG 未全过 UX 清单。
- **Dexie v10** 已上 main，旧客户端勿回退版本。

## CI 备注

合并后 GitHub **CI** 在跑（含 macOS/Windows Rust）。与本 PR 无关的 Rust 红不阻塞本次 web 验收；web 侧 15 项 Playwright + `typecheck` 已在合并机上绿。

## 本地拉取

```bash
cd /Users/fangchen/Baidu/GitHub/Notes\&ToDo && git pull origin main
```
