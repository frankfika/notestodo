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
        className="flex items-center gap-2 h-8 px-3 rounded-full bg-bg-raise/90 backdrop-blur border border-line shadow-sm text-xs text-text-1 hover:border-line-strong transition-colors"
      >
        <span className="font-medium">收件箱</span>
        {items.length > 0 && (
          <span className="text-[10px] text-text-3 shrink-0">{items.length}</span>
        )}
      </button>

      {open && (
        <div className="absolute top-10 left-0 z-40 w-72 card shadow-lg flex flex-col text-xs">
          <div className="px-3 py-2.5 border-b border-line">
            <div className="font-medium text-text-2">收件箱</div>
            <div className="mt-0.5 text-[11px] text-text-3">先随手记下来，再决定放进哪张图。</div>
          </div>
          <div className="p-2 flex gap-1 border-b border-line">
            <input
              value={title}
              name="mindmapInboxCapture"
              autoComplete="off"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') void submit()
              }}
              placeholder="记一条想法或待办…"
              className="input !h-7 flex-1 min-w-0 text-xs"
            />
            <button type="button" onClick={() => void submit()} className="px-2 h-7 rounded-md bg-bg-overlay hover:bg-bg-raise text-text-2">
              添加
            </button>
          </div>
          <ul className="max-h-[52vh] overflow-y-auto p-1 space-y-0.5">
            {items.length === 0 && <li className="px-2 py-3 text-text-3">这里还没有内容</li>}
            {items.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => focusLeaf(t.id)}
                  className="w-full text-left px-2 py-1 rounded-md hover:bg-bg-overlay truncate"
                  title={t.waiting_reason ? `等待原因：${t.waiting_reason}` : t.title}
                >
                  {t.waiting_reason && <span className="text-warning mr-1">等待中</span>}
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
