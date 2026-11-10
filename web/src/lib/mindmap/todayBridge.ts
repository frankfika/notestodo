import type { ID } from '../../types'
import { addSlot, getToday } from './todaySlots'
import { pushTodayStateUndo } from './undoStack'

export type TodaySwapRequest = { leafId: ID; mapId: ID }

type SwapHandler = (req: TodaySwapRequest) => void

let swapHandler: SwapHandler | null = null

/** TodayTray 注册；MindmapCanvas 满槽时通过 askTodaySwap 触发显式换出 UI */
export function registerTodaySwapHandler(handler: SwapHandler | null): void {
  swapHandler = handler
}

export function askTodaySwap(leafId: ID, mapId: ID): void {
  swapHandler?.({ leafId, mapId })
}

/** 脑图选中叶子 ⌘T：成功静默入槽，满槽则交给 TodayTray 换出 */
export async function tryAddTodaySlot(leafId: ID, mapId: ID): Promise<void> {
  const before = await getToday()
  const r = await addSlot(leafId, mapId)
  if (r.ok) pushTodayStateUndo(before, '加入 Today')
  else if (r.reason === 'full') askTodaySwap(leafId, mapId)
}
