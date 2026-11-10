# 多 Agent 任务：脑图收尾到可发布

工作目录：本 worktree。用中文。必须用多个子 agent 并行（Task/Agent），不要一个人串行磨。

## 现状
- 基于 origin/main（Phase1/2 已合）。正在合本地 UX `939d5bc`。
- 仍有 UU：SettingsPage.tsx、TodosPage.tsx、TodosTree.tsx。
- mindmap_tasks 默认 false；Dexie 不降级；ME metadata；allowUndo:false + undoStack。

## 并行拆分（立刻 spawn）
1. **conflict-fixer**：只清 3 个冲突并 stage。
2. **f02-f09**：冲突文件之外推 F-02/F-09；冲突清完后再碰那三文件。
3. **tester**：依赖冲突基本清完后跑测修到绿。
4. **acceptance**：测试有结果后写 phase2-claude-acceptance.md。

协调者你负责：派工、合并结果、开 PR 到 main（有改动时）、最终短纪要（分支/PR、测试、验收路径、待决策）。

硬约束同前：无 maps 进 SYNC；无双轨可写；无 AI 自动入 Today；无整图重画；不 force-push main。

现在就开始派多个 agent。
