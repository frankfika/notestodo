import { type JSX, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useUI } from '../../state/ui'
import { captureToInbox, listInboxCaptures } from '../../lib/mindmap/inboxCapture'
import { ensureInboxMap, findInboxMap } from '../../lib/mindmap/mapRoots'

type InboxDrawerProps = {
  onOpenInboxMap: (inboxId: string) => void
}

/**
 * F-04 · Inbox 捕获（浮层版）
 *
 * 原来是常驻左侧栏（176px）。画布要宽度 —— 收成左上角一个入口，
 * 点开才出现捕获框和捕获列表；捕获完可以直接跳到 Inbox 图。
 */
export default function InboxDrawer({ onOpenInboxMap }: InboxDrawerProps): JSX.Element {
  // liveQuery 的 querier 必须只读：在里面写库 Dexie 会抛
  // "Readwrite transaction in liveQuery context"，整个页面会被 ErrorBoundary 吞掉。
  const items = useLiveQuery(listInboxCaptures, []) ?? []
  const inbox = useLiveQuery(findInboxMap, [])
  const [title, setTitle] = useState('')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Inbox 根图的创建放在响应式读路径之外（事务外），幂等。
  useEffect(() => {
    void ensureInboxMap().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const focusLeaf = (id: string): void => {
    if (inbox) onOpenInboxMap(inbox.id)
    useUI.setState({ todoFocusId: id })
    setOpen(false)
  }

  const submit = async (): Promise<void> => {
    const raw = title.trim()
    if (!raw) return
    const t = await captureToInbox(raw)
    setTitle('')
    focusLeaf(t.id)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Inbox 捕获"
        aria-label="Inbox 捕获"
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-[10px] bg-bg-raise/85 backdrop-blur border border-line text-xs text-text-1 hover:border-accent/60 transition-colors"
      >
        <span className="text-text-3 shrink-0">↓</span>
        <span className="font-medium">Inbox</span>
        {items.length > 0 && (
          <span className="text-[10px] text-text-3 shrink-0">{items.length}</span>
        )}
      </button>

      {open && (
        <div className="absolute top-9 left-0 z-40 w-64 card shadow-lg flex flex-col text-xs">
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
          <ul className="max-h-[52vh] overflow-y-auto p-1 space-y-0.5">
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
        </div>
      )}
    </div>
  )
}
