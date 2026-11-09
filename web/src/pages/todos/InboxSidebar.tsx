import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { getInboxMapId, listInboxCaptureLeaves } from '../../lib/mindmap/inbox'
import type { ID } from '../../types'

export type InboxSidebarProps = {
  onOpenInbox: (inboxId: ID) => void
}

export default function InboxSidebar({ onOpenInbox }: InboxSidebarProps): JSX.Element {
  const goTodos = useUI((s) => s.goTodos)
  const inboxId = useLiveQuery(getInboxMapId, [])
  const todos = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const leaves = inboxId ? listInboxCaptureLeaves(todos, inboxId) : []

  const openLeaf = (leafId: ID): void => {
    if (inboxId) onOpenInbox(inboxId)
    goTodos(leafId)
  }

  return (
    <aside className="w-[200px] shrink-0 border-b border-line p-3 flex flex-col gap-2 max-h-[40%] min-h-0">
      <div className="text-sm font-medium text-text-1">Inbox</div>
      <p className="text-[11px] text-text-3 leading-snug">快速捕获的叶子；点一项进入 Inbox 图整理。</p>
      <ul className="flex flex-col gap-1 flex-1 overflow-y-auto min-h-0">
        {leaves.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className="w-full text-left text-sm truncate py-1 hover:text-accent"
              onClick={() => openLeaf(t.id)}
            >
              {t.title || '未命名'}
            </button>
          </li>
        ))}
        {leaves.length === 0 && (
          <li className="text-xs text-text-3 py-2">上方回车捕获到此</li>
        )}
      </ul>
    </aside>
  )
}
