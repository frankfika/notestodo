import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { archiveMap, restoreMap } from '../../lib/mindmap/mapArchive'
import { INBOX_TITLE, listArchivedMapRoots, listMapRoots } from '../../lib/mindmap/mapRoots'
import type { ID } from '../../types'

type MapLibTab = 'active' | 'archived'

export type MapLibraryPanelProps = {
  rootId: string | null
  onSelect: (id: ID) => void
}

/** 轻量图库：活跃 vs 归档 */
export default function MapLibraryPanel({ rootId, onSelect }: MapLibraryPanelProps): JSX.Element {
  const [libTab, setLibTab] = useState<MapLibTab>('active')
  const activeRoots = useLiveQuery(listMapRoots, []) ?? []
  const archivedRoots = useLiveQuery(listArchivedMapRoots, []) ?? []
  const [msg, setMsg] = useState<string | null>(null)

  const rows = libTab === 'active' ? activeRoots : archivedRoots
  const current = rows.find((r) => r.id === rootId) ?? activeRoots.find((r) => r.id === rootId)

  const onArchive = async (): Promise<void> => {
    if (!rootId) return
    setMsg(null)
    const r = await archiveMap(rootId)
    if (!r.ok) {
      const text =
        r.reason === 'open_leaves' ? '仍有开放叶子，请先完成或删掉再归档'
          : r.reason === 'inbox' ? 'Inbox 不能归档'
            : r.reason === 'already' ? '已在归档库'
              : '归档失败'
      setMsg(text)
      return
    }
    const next = activeRoots.find((x) => x.id !== rootId)
    if (next) onSelect(next.id)
    else onSelect(activeRoots[0]?.id ?? rootId)
    setMsg('已移入归档库')
  }

  const onRestore = async (id: ID): Promise<void> => {
    setMsg(null)
    const r = await restoreMap(id)
    if (!r.ok) {
      setMsg('恢复失败')
      return
    }
    setLibTab('active')
    onSelect(id)
    setMsg('已恢复到进行中')
  }

  const canArchive =
    libTab === 'active' &&
    rootId &&
    current?.title !== INBOX_TITLE &&
    activeRoots.some((r) => r.id === rootId)

  return (
    <aside className="w-44 shrink-0 border-r border-line flex flex-col flex-1 min-h-0 bg-bg-base">
      <div className="px-2 pt-2 pb-1 border-b border-line">
        <div className="text-[11px] text-text-3 mb-1.5 px-1">图库</div>
        <div className="flex rounded-[6px] bg-bg-overlay p-0.5">
          {([
            ['active', '进行中'],
            ['archived', '已归档'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => { setLibTab(k); setMsg(null) }}
              className={`flex-1 h-6 rounded-[4px] text-[11px] transition-colors ${
                libTab === k ? 'bg-bg-raise text-text-1 font-medium' : 'text-text-2 hover:text-text-1'
              }`}
            >{label}</button>
          ))}
        </div>
      </div>
      <ul className="flex-1 overflow-y-auto py-1 px-1 flex flex-col gap-0.5">
        {rows.length === 0 && (
          <li className="text-[11px] text-text-3 px-2 py-2">
            {libTab === 'active' ? '暂无进行中的图' : '归档库为空'}
          </li>
        )}
        {rows.map((r) => {
          const selected = rootId === r.id
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                className={`w-full text-left px-2 py-1.5 rounded-[6px] text-xs truncate transition-colors ${
                  selected ? 'bg-bg-raise text-text-1 font-medium' : 'text-text-2 hover:bg-bg-overlay hover:text-text-1'
                }`}
              >{r.title || '未命名'}</button>
            </li>
          )
        })}
      </ul>
      <div className="px-2 py-2 border-t border-line flex flex-col gap-1">
        {canArchive && (
          <button
            type="button"
            className="w-full h-7 rounded-[6px] text-[11px] text-text-2 hover:bg-bg-overlay hover:text-text-1 border border-line"
            onClick={() => void onArchive()}
          >归档当前图</button>
        )}
        {libTab === 'archived' && rootId && archivedRoots.some((r) => r.id === rootId) && (
          <button
            type="button"
            className="w-full h-7 rounded-[6px] text-[11px] text-accent hover:bg-bg-overlay border border-line"
            onClick={() => void onRestore(rootId)}
          >恢复此图</button>
        )}
        {msg && <p className="text-[10px] text-text-3 leading-snug">{msg}</p>}
      </div>
    </aside>
  )
}
