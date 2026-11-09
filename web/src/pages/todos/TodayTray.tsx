import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { registerTodaySwapHandler } from '../../lib/mindmap/todayBridge'
import { getToday, removeSlot, swapSlot } from '../../lib/mindmap/todaySlots'
import type { ID } from '../../types'

type PendingSwap = { leafId: ID; mapId: ID } | null

export default function TodayTray(): JSX.Element {
  const goTodos = useUI((s) => s.goTodos)
  const state = useLiveQuery(getToday, []) ?? { capacity: 5, slots: [] }
  const todos = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const [pending, setPending] = useState<PendingSwap>(null)

  useEffect(() => {
    registerTodaySwapHandler((req) => setPending(req))
    return () => registerTodaySwapHandler(null)
  }, [])

  const titleOf = (id: ID) => todos.find((t) => t.id === id)?.title ?? id.slice(0, 6)

  return (
    <aside className="w-[240px] shrink-0 border-l border-line p-3 flex flex-col gap-2">
      <div className="text-sm font-medium text-text-1">
        Today · {state.slots.length}/{state.capacity}
      </div>
      <ul className="flex flex-col gap-1 flex-1 overflow-y-auto">
        {state.slots.map((s) => (
          <li key={s.leafId} className="flex items-center gap-1">
            <button
              type="button"
              className="flex-1 text-left text-sm truncate hover:text-accent"
              onClick={() => goTodos(s.leafId)}
            >
              {titleOf(s.leafId)}
            </button>
            <button
              type="button"
              className="text-xs text-text-3"
              onClick={() => void removeSlot(s.leafId)}
              aria-label="移出 Today"
            >
              ×
            </button>
          </li>
        ))}
        {state.slots.length === 0 && (
          <li className="text-xs text-text-3 py-4">选中叶子按 ⌘T 加入</li>
        )}
      </ul>

      {pending && (
        <div className="rounded-[10px] border border-line bg-bg-raise p-2 shadow-sm">
          <div className="text-xs text-text-2 mb-2">Today 已满，替换哪一项？</div>
          {state.slots.map((s) => (
            <button
              key={s.leafId}
              type="button"
              className="block w-full text-left text-sm py-1 hover:text-accent"
              onClick={() => {
                void swapSlot(pending.leafId, pending.mapId, s.leafId)
                setPending(null)
              }}
            >
              替换「{titleOf(s.leafId)}」
            </button>
          ))}
          <button type="button" className="text-xs text-text-3 mt-1" onClick={() => setPending(null)}>
            取消
          </button>
        </div>
      )}
    </aside>
  )
}
