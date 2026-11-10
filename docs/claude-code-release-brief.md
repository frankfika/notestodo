# Claude Code 任务：脑图任务收尾到可发布（续跑 · MiniMax-M3.1-Flash）

你在 worktree：`/Users/fangchen/Baidu/GitHub/Notes&ToDo/.claude/worktrees/mindmap-finalize`（远程 `frankfika/notestodo`）。用中文。可开多 agent。

## 当前状态（接着干，勿推倒重来）
- 分支 `worktree-mindmap-finalize` 已基于 `origin/main`（含 Phase1/2 脑图合入，HEAD ~6804697）。
- 正在把本地 UX 提交 `939d5bc` 合进来；**仍有未解决冲突**：
  - `UU web/src/pages/settings/SettingsPage.tsx`
  - `UU web/src/pages/todos/TodosPage.tsx`
  - `UU web/src/pages/todos/TodosTree.tsx`
- 主仓库路径仍是 `/Users/fangchen/Baidu/GitHub/Notes&ToDo`；未跟踪 `ux-2026-11-01/` 勿删。
- 验收底稿：`docs/phase2-release-acceptance.md`（F-02/F-09 partial；flag 默认 false）。

## 按序执行
1. **解决冲突并完成对齐**：保留脑图 Phase1/2 行为 + 本地 UX 合理部分；不要 `reset --hard`；不要 force-push `main`。
2. **收尾 F-02 / F-09** 尽量到 pass（可自动化的快捷键/视觉 + 测试）。
3. **测试直到绿**：
   ```bash
   cd web && pnpm install && pnpm typecheck && pnpm build
   cd web && pnpm exec playwright test tests/mindmap-*.spec.ts tests/local-api.spec.ts
   ```
4. **写** `docs/phase2-claude-acceptance.md`（F-01..F-10、R1–R6：pass/partial/gap + 命令结果）。
5. **开 PR 到 main**（有代码改动时）；结束时输出：分支/PR URL、测试结果、验收路径、待 Fang 决策项。

## 硬约束
- `mindmap_tasks` 默认 false；Dexie 不降级；中文 UI
- ME@6 metadata；allowUndo:false + undoStack
- 无 maps 进 SYNC；无双轨可写；无 AI 自动入 Today；无整图重画

开始执行，完成后给可开会短纪要。
