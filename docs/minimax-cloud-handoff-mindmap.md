# MiniMax 云电脑交接：notestodo 脑图收尾（F-02 / F-09 + UX 合入）

更新时间：2026-11-10 08:25 CST（Asia/Shanghai）  
仓库：https://github.com/frankfika/notestodo  
分支：`worktree-mindmap-finalize`（请从此分支继续，勿直接改 `main`）  
本地原路径（仅供对照）：`/Users/fangchen/Baidu/GitHub/Notes&ToDo/.claude/worktrees/mindmap-finalize`

## 目标（完成即停）

1. 让 `web/tests/mindmap-shortcuts.spec.ts`（及必要的 `mindmap-*.spec.ts` / local-api）**变绿或合理 skip 并写明原因**。
2. 补齐 / 刷新 `docs/phase2-claude-acceptance.md`（已定事实 vs 假设、测试命令与数字、需求对比、风险）。
3. `gh pr create`：**base=`main`**，head=`worktree-mindmap-finalize`，标题/正文中英均可，写清未合入原因与测试状态。
4. **不要**把 `mindmap_tasks` 默认改成 `true`（`web/src/lib/features.ts` 保持 `false`），除非 Fang 书面确认。
5. **不要**降级 Dexie（保持 v10）。
6. **不要**再写 `zz-dbg*.spec.ts` 之类调试专用 spec；有问题直接修产品或改正式测试。

## 已定事实

| 项 | 状态 |
|---|---|
| Phase1–2 mindmap 主体 | 已在 `main`（含 F-01/04/05/08 等；HEAD 合入点见下方 commit） |
| 本地 UX 大改 `939d5bc` | 已 cherry-pick 到本分支 → commit `573ae14` |
| F-02 / F-09 WIP | 已提交本分支 → 见最新 commit（MindmapCanvas / mindmap.css / shortcuts 测试 / visual 测试） |
| feature flag | `mindmap_tasks` **默认 false** |
| 本机 Claude Code 多 agent | **已停止**；巡检 routine 已暂停；不要依赖本机会话 |

### 关键 commit（推送后以 `git log` 为准）

- `6804697` Merge PR #31 phase2-shortcuts（cherry-pick 基线）
- `573ae14` feat: 全产品 UX 重做（从 main 上 ahead 的 `939d5bc` cherry-pick 而来）
- 后续 commit：F-02/F-09 WIP + 本交接文档 + 相关 docs

## 未完成 / 已知失败

### Playwright：`mindmap-shortcuts.spec.ts`

本机最后一次跑（2026-11-10 ~08:19，日志 `/tmp/pw-short.log`，会话被中断前）：

- 至少前 9 个用例全部 **✘**，单测约 **15–16s** 超时量级（很像 **选不中节点 / 画布未就绪 / 选择器对不上**，而不是断言瞬间失败）。
- 日志被停掉时 **没有**完整 `Error:` 堆栈与最终 pass/fail 汇总；请在云上重跑拿完整 reporter 输出。

失败用例标题（已观察到）：

1. Tab：新增子节点  
2. Enter：新增兄弟节点  
3. ⇧Tab：提升一级  
4. ⌥Tab：降低一级  
5. ⌘Enter：进入编辑  
6. Delete：删除节点  
7. Space：叶子可完成  
8. Space：非叶子无效并给出可教提示  
9. Space：编辑节点标题时不触发完成  
（文件里还有 ⌘T / Waiting / 切图 / 快捷键面板等，本机未跑完）

### 高度可疑根因（待验证，勿当结论）

1. **选择器**：测试用 `.mindmap-canvas .me-tpc[data-nodeid="me${id}"]`（Mind Elixir `data-nodeid="me…"`）。若 ME 版本/DOM 与假设不符，`topic().click()` 会空点，后续键盘全挂。  
2. **就绪时序**：`openMindmap` 只 `waitFor` `.mindmap-canvas` 与第一个 `.me-tpc`；`MindmapCanvas` 有异步 `ready` / `selectNode` 逻辑，可能「看得见节点但还没挂好键盘」。  
3. **默认打开的图**：seed 用负 `sort_order` 想压过系统 Inbox；若 Inbox/图库逻辑变化，可能打开的不是 `proj`。  
4. **F-09 视觉**：`MINIMAL_PALETTE` + `mindmap.css` 大改；`mindmap-visual.spec.ts` 为新增，**本机未出结果**。

## 建议在云上的工作顺序

```bash
git clone https://github.com/frankfika/notestodo.git
cd notestodo
git fetch origin
git checkout worktree-mindmap-finalize
cd web
pnpm i   # 或仓库惯用安装方式
# 跑脑图相关（先 shortcuts，再全量 mindmap）
pnpm exec playwright test tests/mindmap-shortcuts.spec.ts --reporter=list
pnpm exec playwright test tests/mindmap- --reporter=list
# 有 local-api 脚本则一并跑；以 package.json scripts 为准
```

修复策略（最小改动优先）：

1. 先用 Playwright trace / headed 看：seed 后 URL、是否出现 `.me-tpc`、`data-nodeid` 实际值、焦点是否在画布。  
2. 修 **测试等待/选择器** 或 **MindmapCanvas 就绪/选中** 其一，避免再开调试 spec。  
3. 单测绿后再跑全套 `mindmap-*`；截图类失败可更新 baseline 或 skip 并注明。  
4. 写 `docs/phase2-claude-acceptance.md`（可参考 `docs/phase2-release-acceptance.md`）。  
5. `gh pr create --base main --head worktree-mindmap-finalize ...`

## 约束清单（务必遵守）

- 合入 / 交付前必须跑测试，并对照产品文档做需求对比；不能只开 PR。  
- 用户偏好：极简 Apple 风；一图一项目可切换；完成项淡出；规划（脑图）与执行（叶子清单）分离。  
- 开源仓库；不要提交密钥、本机绝对路径依赖、或把默认 flag 偷偷打开。  
- 付费 / 对外承诺勿擅自做。

## 参考文档（已在本分支）

- `docs/ux-plan-2026-11.md` — UX 大改依据  
- `docs/phase1-merge-acceptance.md` / `docs/phase2-release-acceptance.md` — 既有验收  
- `docs/claude-code-release-brief.md` / `docs/claude-code-multi-brief.md` / `docs/claude-multi-agents.json` — 本机多 agent 简报（历史）  
- `docs/DESIGN.md` / mindmap 相关实现：`web/src/pages/todos/MindmapCanvas.tsx`、`web/src/lib/mindmap/*`、`web/src/lib/features.ts`

## 一句话给云电脑

**从 `worktree-mindmap-finalize` 接着修 F-02 快捷键 E2E（当前大面积超时红），绿了再写验收文档并开 PR 到 `main`；flag 默认保持关。**
