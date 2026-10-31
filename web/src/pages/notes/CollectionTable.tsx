import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useUI } from '../../state/ui'
import { db } from '../../db/db'
import { fmtDateTime } from '../../lib/id'
import type { Note, Notebook } from '../../types'

type SortKey = 'title' | 'updated_at' | 'pinned'

function stripMd(md: string, max = 200): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')   // 块颜色等 attr 注释不进预览
    .replace(/[#>*_`\-[\]()!]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Notion database 风格表格视图：列头排序 + 行 hover peek 预览 */
export default function CollectionTable({ notes }: { notes: Note[] }): JSX.Element {
  const goNote = useUI((s) => s.goNote)
  const [sortKey, setSortKey] = useState<SortKey>('updated_at')
  const [asc, setAsc] = useState(false)
  const [peek, setPeek] = useState<Note | null>(null)
  const notebooks = useLiveQuery(
    () => db.notebooks.filter((nb: Notebook) => nb.deleted_at === null).toArray(),
    [],
  ) ?? []
  const nbName = (id?: string | null): string =>
    (id && notebooks.find((nb: Notebook) => nb.id === id)?.name) || '—'

  const rows = useMemo(() => {
    const sorted = [...notes].sort((a, b) => {
      if (sortKey === 'title') return (a.title || '未命名笔记').localeCompare(b.title || '未命名笔记')
      if (sortKey === 'pinned') return Number(a.pinned) - Number(b.pinned)
      return a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0
    })
    return asc ? sorted : sorted.reverse()
  }, [notes, sortKey, asc])

  function toggleSort(key: SortKey): void {
    if (key === sortKey) setAsc(!asc)
    else {
      setSortKey(key)
      setAsc(key === 'title')
    }
  }

  const header = (label: string, key: SortKey, className = ''): JSX.Element => (
    <th
      onClick={() => toggleSort(key)}
      className={`text-left text-[11px] font-semibold uppercase text-text-3 tracking-[0.06em] px-5 py-2.5 cursor-pointer select-none hover:text-text-1 transition-colors ${className}`}
    >
      {label} {sortKey === key ? (asc ? '↑' : '↓') : ''}
    </th>
  )

  return (
    <div className="relative">
      <table className="card w-full border-collapse">
        <thead>
          <tr className="border-b border-line">
            {header('标题', 'title')}
            <th className="text-left text-[11px] font-semibold uppercase text-text-3 tracking-[0.06em] px-5 py-2.5 w-28">笔记本</th>
            {header('更新时间', 'updated_at', 'w-40')}
            {header('置顶', 'pinned', 'w-20')}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((n) => (
            <tr
              key={n.id}
              onClick={() => goNote(n.id)}
              onMouseEnter={() => setPeek(n)}
              onMouseLeave={() => setPeek((p) => (p?.id === n.id ? null : p))}
              className="hover:bg-bg-overlay/40 transition-colors cursor-pointer"
            >
              <td className="px-5 py-3 text-sm font-medium text-text-1 truncate max-w-0 w-full">
                {n.pinned ? '▣ ' : ''}{n.title || '未命名笔记'}
              </td>
              <td className="px-5 py-3 text-[11px] text-text-3 whitespace-nowrap">{nbName(n.notebook_id)}</td>
              <td className="px-5 py-3 text-[11px] text-text-3 whitespace-nowrap">{fmtDateTime(n.updated_at)}</td>
              <td className="px-5 py-3 text-[11px] text-text-3">{n.pinned ? '已置顶' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {peek && (
        <div className="card absolute top-0 left-[calc(100%+12px)] w-72 p-4 pointer-events-none shadow-md z-10">
          <div className="text-sm font-medium text-text-1 mb-1.5 truncate">{peek.title || '未命名笔记'}</div>
          <div className="text-xs text-text-2 leading-relaxed whitespace-pre-wrap">
            {stripMd(peek.body_md) || '空白'}
          </div>
        </div>
      )}
    </div>
  )
}
