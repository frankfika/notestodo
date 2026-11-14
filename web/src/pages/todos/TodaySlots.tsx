import { type JSX, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useUI } from '../../state/ui'
import { useAllTodos } from '../../lib/useAllTodos'
import { registerTodaySwapHandler } from '../../lib/mindmap/todayBridge'
import { getToday, removeSlot, swapSlot } from '../../lib/mindmap/todaySlots'
import { pushTodayStateUndo } from '../../lib/mindmap/undoStack'
import type { ID } from '../../types'

type PendingSwap = { leafId: ID; mapId: ID } | null

/**
 * Today 槽位 = 脑图里 ⌘T 入槽的「今天要做的事」。
 *
 * 它属于**执行**，不属于**规划**：原来它常驻在脑图右侧（240px），
 * 现在从脑图 Tab 挪到「今天」页（列表在那儿），脑图右上角只留一个
 * 计数入口 —— 规划时知道今天排了几件事就行，不必占着画布的宽度。
 */

function useSlotTitles(): (id: ID) => string {
  const todos = useAllTodos()
  return (id: ID): string => todos.find((t) => t.id === id)?.title ?? id.slice(0, 6)
}

/** 脑图右上角：Today 计数 + 跳到「今天」页 */
export function TodayIndicator(): JSX.Element {
  const goToday = useUI((s) => s.goToday)
  const state = useLiveQuery(getToday, []) ?? { capacity: 5, slots: [] }
  return (
    <button
      type="button"
      onClick={() => goToday()}
      title="今天要做的事（⌘T 入槽）"
      className="flex items-center gap-2 h-8 px-3 rounded-full bg-bg-raise/90 backdrop-blur border border-line shadow-sm text-xs text-text-1 hover:border-line-strong transition-colors"
    >
      <span className="font-medium">今天</span>
      <span className="text-[10px] text-text-3 shrink-0">{state.slots.length}/{state.capacity}</span>
    </button>
  )
}

/** 满槽时的「替换哪一项？」提示：脑图和「今天」页共用一套 */
export function TodaySwapPrompt(): JSX.Element | null {
  const [pending, setPending] = useState<PendingSwap>(null)
  const titleOf = useSlotTitles()
  const state = useLiveQuery(getToday, []) ?? { capacity: 5, slots: [] }

  useEffect(() => {
    registerTodaySwapHandler((req) => setPending(req))
    return () => registerTodaySwapHandler(null)
  }, [])

  if (!pending) return null
  return (
    <div className="rounded-[12px] border border-line bg-bg-raise/95 backdrop-blur p-2.5 shadow-lg w-64">
      <div className="text-xs text-text-2 mb-2">今天的执行位已经满了，替换哪一项？</div>
      {state.slots.map((s) => (
        <button
          key={s.leafId}
          type="button"
          className="block w-full text-left text-sm py-1.5 px-2 rounded-[8px] hover:bg-bg-overlay hover:text-accent truncate"
          onClick={() => {
            void (async () => {
              const before = await getToday()
              await swapSlot(pending.leafId, pending.mapId, s.leafId)
              pushTodayStateUndo(before, '替换 Today')
              setPending(null)
            })()
          }}
        >
          替换「{titleOf(s.leafId)}」
        </button>
      ))}
      <button type="button" className="text-xs text-text-3 mt-2 px-2" onClick={() => setPending(null)}>
        取消
      </button>
    </div>
  )
}

/** Today 槽位列表（放在「今天」页：今天到底要做哪几件事） */
export function TodaySlotsList(): JSX.Element {
  const goTodos = useUI((s) => s.goTodos)
  const state = useLiveQuery(getToday, []) ?? { capacity: 5, slots: [] }
  const titleOf = useSlotTitles()

  return (
    <div className="flex flex-col gap-1">
      {state.slots.length === 0 && (
        <div className="text-xs text-text-3">还没有加入今天的执行位，在脑图里选中一个叶子按 ⌘T 放进来。</div>
      )}
      {state.slots.map((s) => (
        <div key={s.leafId} className="flex items-center gap-2 rounded-[10px] px-2 py-1.5 hover:bg-bg-overlay/60 transition-colors">
          <button
            type="button"
            className="flex-1 text-left text-sm truncate hover:text-accent"
            onClick={() => goTodos(s.leafId)}
          >
            {titleOf(s.leafId)}
          </button>
          <button
            type="button"
            className="text-xs text-text-3 hover:text-danger shrink-0"
            onClick={() => {
              void (async () => {
                const before = await getToday()
                await removeSlot(s.leafId)
                pushTodayStateUndo(before, '移出 Today')
              })()
            }}
            aria-label="移出 Today"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
