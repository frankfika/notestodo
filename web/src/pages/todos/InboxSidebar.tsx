import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useUI } from '../../state/ui'
import { captureToInbox, listInboxCaptures } from '../../lib/mindmap/inboxCapture'
import { ensureInboxMap } from '../../lib/mindmap/mapRoots'

type InboxSidebarProps = {
  onOpenInboxMap: (inboxId: string) => void
}

/** F-04 · Inbox 捕获侧栏 */
export default function InboxSidebar({ onOpenInboxMap }: InboxSidebarProps): JSX.Element {
  const items = useLiveQuery(listInboxCaptures, []) ?? []
  const inbox = useLiveQuery(ensureInboxMap, [])
  const [title, setTitle] = useState('')

  const focusLeaf = (id: string): void => {
    if (inbox) onOpenInboxMap(inbox.id)
    useUI.setState({ todoFocusId: id })
  }

  const submit = async (): Promise<void> => {
    const raw = title.trim()
    if (!raw) return
    const t = await captureToInbox(raw)
    setTitle('')
    focusLeaf(t.id)
  }

  return (
    <aside className="w-44 shrink-0 border-r border-line flex flex-col bg-bg-base/50 text-xs">
      <div className="px-2 py-2 border-b border-line font-medium text-text-2">Inbox</div>
      <div className="p-2 flex gap-1 border-b border-line">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') void submit()
          }}
          placeholder="捕获…"
          className="input !h-7 flex-1 min-w-0 text-xs"
        />
        <button type="button" onClick={() => void submit()} className="px-1.5 h-7 rounded-md bg-bg-overlay hover:bg-bg-raise">
          +
        </button>
      </div>
      <ul className="flex-1 overflow-y-auto p-1 space-y-0.5">
        {items.length === 0 && <li className="px-1 py-2 text-text-3">暂无捕获</li>}
        {items.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => focusLeaf(t.id)}
              className="w-full text-left px-2 py-1 rounded-md hover:bg-bg-overlay truncate"
              title={t.waiting_reason ? `Waiting: ${t.waiting_reason}` : t.title}
            >
              {t.waiting_reason && <span className="text-warning mr-0.5">◷</span>}
              {t.title || '未命名'}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
