# Phase2 发布收口计划

基线：`docs/phase1-merge-acceptance.md`，main 已合 A–E。

## 线程与建议合入顺序

1. **F-08 + F-01** 图归档 API/UI + 轻量图库
2. **R4** 统一撤销栈 + ME/business 对齐
3. **F-04 + F-05 + R1** Inbox 侧栏、Waiting 标示、叶子教练
4. **F-02 + F-09** 快捷键、视觉、200 节点烟测
5. **发布整合** 顺序 merge、全套 Playwright、`docs/phase2-release-acceptance.md`

## 纪律

每 PR：Playwright + typecheck 绿 → pass/partial/gap 表 → merge。`mindmap_tasks` 默认 **false** 除非 Fang 书面确认。

## 规格

- 产品 F/UX: https://cursor.com/canvas/store-2bb395cd-d76f-455a-bab4-1ec32bbd2b2d/049f996d-093f-47dc-b49a-79408ec18b45
- 技术 v3: https://cursor.com/canvas/store-2bb395cd-d76f-455a-bab4-1ec32bbd2b2d/ec391385-aed8-4be4-b1e0-c1468edb925d
