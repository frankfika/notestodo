import { useLiveQuery } from 'dexie-react-hooks'
import { listMapRoots } from '../../lib/mindmap/mapRoots'
import type { ID } from '../../types'

export type MapPickerDisclosureProps = {
  open: boolean
  onPick: (mapId: ID, parentId: ID) => void
  onClose: () => void
}

/** 「改位置…」二级：选图根（parentId 默认=图根；会议分支由 PendingTodos 的 confirm 链处理） */
export default function MapPickerDisclosure({
  open, onPick, onClose,
}: MapPickerDisclosureProps): JSX.Element | null {
  const roots = useLiveQuery(listMapRoots, []) ?? []
  if (!open) return null
  return (
    <div className="mt-2 rounded-[8px] border border-line p-2 bg-bg-overlay">
      <div className="text-[11px] text-text-3 mb-1">落到哪张图</div>
      <ul className="flex flex-col gap-1">
        {roots.map((r) => (
          <button
            key={r.id}
            type="button"
            className="text-left text-sm hover:text-accent"
            onClick={() => { onPick(r.id, r.id); onClose() }}
          >{r.title || '未命名'}</button>
        ))}
      </ul>
    </div>
  )
}
