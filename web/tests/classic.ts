import type { Page } from '@playwright/test'

/**
 * 显式关闭脑图开关，回到经典任务树/列表。
 * mindmap_tasks 默认已开；验证经典 UI 契约（行菜单/拖拽/看板入口/资料页…）的
 * 用例在 goto(BASE) 之后调一次本函数，脑图行为由 mindmap-* spec 显式开关注。
 */
export async function useClassicTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { setFeature } = await import('/src/lib/features.ts')
    await setFeature('mindmap_tasks', false)
  })
}
