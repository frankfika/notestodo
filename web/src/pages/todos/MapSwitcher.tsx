import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { archiveMap, restoreMap } from '../../lib/mindmap/mapArchive'
import { INBOX_TITLE, listArchivedMapRoots, listMapRoots } from '../../lib/mindmap/mapRoots'
import type { ID } from '../../types'

type MapLibTab = 'active' | 'archived'

export type MapSwitcherProps = {
  rootId: string | null
  onSelect: (id: ID) => void
}

/**
 * 图库浮层：一图一项目，切图不再占一条常驻侧栏。
 *
 * 为什么改成浮层：图库 176 + Inbox 176 + Today 240 三条常驻面板，
 * 在 1280 的窗口里把画布挤到 456px —— 树是能放下，但看着憋屈。
 * 收成浮层后画布吃满整宽（1280 下 ~1048px），面板按需出现。
 */
export default function MapSwitcher({ rootId, onSelect }: MapSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [libTab, setLibTab] = useState<MapLibTab>('active')
  const activeRoots = useLiveQuery(listMapRoots, []) ?? []
  const archivedRoots = useLiveQuery(listArchivedMapRoots, []) ?? []
  const [msg, setMsg] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

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
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="切换项目图"
        aria-label="切换项目图"
        className="flex items-center gap-1.5 h-8 max-w-[220px] px-2.5 rounded-[10px] bg-bg-raise/85 backdrop-blur border border-line text-xs text-text-1 hover:border-accent/60 transition-colors"
      >
        <span className="text-text-3 shrink-0">◱</span>
        <span className="truncate font-medium">{current?.title || '未命名'}</span>
        <span className="text-text-3 shrink-0">▾</span>
      </button>

      {open && (
        <div className="absolute top-9 left-0 z-40 w-60 card shadow-lg p-2 flex flex-col gap-1.5">
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

          <ul className="max-h-[52vh] overflow-y-auto flex flex-col gap-0.5">
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
                    onClick={() => { onSelect(r.id); setOpen(false) }}
                    className={`w-full text-left px-2 py-1.5 rounded-[6px] text-xs truncate transition-colors ${
                      selected ? 'bg-bg-raise text-text-1 font-medium' : 'text-text-2 hover:bg-bg-overlay hover:text-text-1'
                    }`}
                  >{r.title || '未命名'}</button>
                </li>
              )
            })}
          </ul>

          <div className="flex flex-col gap-1 border-t border-line pt-1.5">
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
            {msg && <p className="text-[10px] text-text-3 leading-snug px-1">{msg}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
