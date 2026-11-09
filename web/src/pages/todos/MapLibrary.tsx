import { useLiveQuery } from 'dexie-react-hooks'
import type { Todo } from '../../types'
import { archiveMapRoot, listArchivedMapRoots, listMapRoots, unarchiveMapRoot } from '../../lib/mindmap/mapRoots'

type MapLibraryProps = {
  open: boolean
  onClose: () => void
  currentId: string | null
  onPick: (id: string) => void
}

/** 轻量图库：活跃图切换 + 归档区 */
export default function MapLibrary({ open, onClose, currentId, onPick }: MapLibraryProps): JSX.Element | null {
  const active = useLiveQuery(listMapRoots, []) ?? []
  const archived = useLiveQuery(listArchivedMapRoots, []) ?? []

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center pt-24 bg-black/20"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl border border-line bg-bg-raise shadow-lg p-4 text-sm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="图库"
      >
        <MapSection
          title="活跃图"
          items={active}
          currentId={currentId}
          onPick={onPick}
          actionLabel="归档"
          onAction={(id) => void archiveMapRoot(id)}
        />
        {archived.length > 0 && (
          <MapSection
            title="已归档"
            items={archived}
            currentId={currentId}
            onPick={onPick}
            actionLabel="还原"
            onAction={(id) => void unarchiveMapRoot(id)}
          />
        )}
        <button type="button" onClick={onClose} className="mt-3 text-text-2 hover:text-text-1">
          关闭
        </button>
      </div>
    </div>
  )
}

function MapSection(props: {
  title: string
  items: Todo[]
  currentId: string | null
  onPick: (id: string) => void
  actionLabel: string
  onAction: (id: string) => void
}): JSX.Element {
  const { title, items, currentId, onPick, actionLabel, onAction } = props
  return (
    <div className="mb-3">
      <p className="text-xs text-text-3 mb-2 font-medium">{title}</p>
      <ul className="space-y-1">
        {items.map((r) => (
          <li key={r.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPick(r.id)}
              className={`flex-1 text-left px-2 py-1 rounded-md truncate ${
                currentId === r.id ? 'bg-bg-overlay font-medium' : 'hover:bg-bg-overlay'
              }`}
            >
              {r.title || '未命名'}
            </button>
            <button
              type="button"
              onClick={() => onAction(r.id)}
              className="text-xs text-text-3 hover:text-text-1 shrink-0"
            >
              {actionLabel}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
