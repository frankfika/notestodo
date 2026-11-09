import { useEffect, useState } from 'react'
import type { ID, Todo } from '../../types'
import { indexByParent, isLeafTodo, todayEligible } from '../../lib/mindmap/leaf'
import { addSplitChild } from '../../lib/mindmap/splitStep'
import { db } from '../../db/db'
import { now } from '../../lib/id'

export type CoachHint = 'split-for-today' | null

export type MindmapCoachBarProps = {
  selected: Todo | null
  all: Todo[]
  coachHint: CoachHint
  onClearHint: () => void
  onFocusTodo: (id: ID) => void
}

export default function MindmapCoachBar({
  selected,
  all,
  coachHint,
  onClearHint,
  onFocusTodo,
}: MindmapCoachBarProps): JSX.Element | null {
  const [waitingDraft, setWaitingDraft] = useState('')

  useEffect(() => {
    setWaitingDraft(selected?.waiting_reason ?? '')
  }, [selected?.id, selected?.waiting_reason])

  if (!selected) {
    return (
      <div className="shrink-0 border-t border-line px-3 py-1.5 text-[11px] text-text-3">
        选中节点：叶子可按 <kbd className="px-1 rounded bg-bg-overlay">⌘T</kbd> 入 Today，
        <kbd className="px-1 rounded bg-bg-overlay">Space</kbd> 完成
      </div>
    )
  }

  const byParent = indexByParent(all)
  const leaf = isLeafTodo(selected, byParent)
  const canToday = todayEligible(selected, byParent)

  const saveWaiting = async (reason: string): Promise<void> => {
    const wr = reason.trim() || undefined
    await db.todos.update(selected.id, {
      waiting_reason: wr,
      updated_at: now(),
      sync_version: selected.sync_version + 1,
    })
  }

  const onSplit = async (): Promise<void> => {
    const childId = await addSplitChild(selected)
    onClearHint()
    onFocusTodo(childId)
  }

  if (coachHint === 'split-for-today' && !leaf) {
    return (
      <div className="shrink-0 border-t border-line px-3 py-2 flex items-center gap-2 flex-wrap bg-bg-overlay/40">
        <span className="text-xs text-text-2">只有叶子能进 Today</span>
        <button type="button" className="text-xs text-accent font-medium" onClick={() => void onSplit()}>
          拆一步
        </button>
        <button type="button" className="text-xs text-text-3 ml-auto" onClick={onClearHint}>
          知道了
        </button>
      </div>
    )
  }

  return (
    <div className="shrink-0 border-t border-line px-3 py-2 flex items-center gap-3 flex-wrap text-xs text-text-2">
      {leaf ? (
        <>
          {canToday ? (
            <span>
              <kbd className="px-1 rounded bg-bg-overlay">⌘T</kbd> 加入 Today
            </span>
          ) : selected.waiting_reason ? (
            <span className="text-text-3">Waiting 中，不可入 Today</span>
          ) : null}
          <label className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="text-text-3 shrink-0">Waiting</span>
            <input
              className="input !h-7 !text-xs flex-1 min-w-[8rem]"
              value={waitingDraft}
              onChange={(e) => setWaitingDraft(e.target.value)}
              onBlur={() => void saveWaiting(waitingDraft)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                }
              }}
              placeholder="等人/条件（留空取消）"
            />
          </label>
        </>
      ) : (
        <>
          <span>结构节点：用 Tab 拆子节点</span>
          <button type="button" className="text-accent font-medium" onClick={() => void onSplit()}>
            拆一步
          </button>
          <span className="text-text-3">
            <kbd className="px-1 rounded bg-bg-overlay">⌘T</kbd> 需先拆成叶子
          </span>
        </>
      )}
    </div>
  )
}
