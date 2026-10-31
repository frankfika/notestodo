import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useUI } from '../../state/ui'
import { db } from '../../db/db'
import { fmtDateTime } from '../../lib/id'
import { createPage } from '../../lib/notes'
import EmptyState from '../../components/EmptyState'
import CollectionTable from './CollectionTable'

/**
 * 笔记列表：左侧全部笔记；右侧「新建笔记」按钮。
 * 会议纪要类型的 Note 也展示在列表里，但带「会议」标记。
 */
export default function NotesPage(): JSX.Element {
  const notesRaw = useLiveQuery(
    () => db.notes.orderBy('updated_at').reverse().toArray(),
    [],
  ) ?? []
  // pinned 在前（按 updated_at 倒序），其余按 updated_at 倒序
  const notes = useMemo(() => {
    return [...notesRaw].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0
    })
  }, [notesRaw])
  const goNote = useUI((s) => s.goNote)
  const [view, setView] = useState<'list' | 'table'>('list')
  // 表格视图只收自由页面（非会议笔记、未删除）
  const tableNotes = useMemo(
    () => notesRaw.filter((n) => !n.meeting_id && !n.deleted_at),
    [notesRaw],
  )

  async function createNote(): Promise<void> {
    goNote(await createPage(null))
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-6 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <div className="section-title">NOTES</div>
            <h1 className="text-2xl font-semibold text-text-1 mt-1">笔记</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex rounded-[10px] border border-line bg-bg-raise p-0.5 text-xs">
              {(['list', 'table'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`h-7 px-3 rounded-lg transition-colors ${
                    view === v ? 'bg-bg-overlay text-text-1 font-medium' : 'text-text-3 hover:text-text-1'
                  }`}
                >
                  {v === 'list' ? '列表' : '表格'}
                </button>
              ))}
            </div>
            <button onClick={() => void createNote()} className="btn-primary text-sm h-9 px-4">
              + 新建笔记
            </button>
          </div>
        </div>

        {view === 'table' ? (
          tableNotes.length === 0 ? (
            <div className="card">
              <EmptyState
                icon="✎"
                title="还没有笔记"
                hint="把会议之外的灵感记在这里；插入待办能从笔记直接挂到 OKR 体系。"
                action={
                  <button onClick={() => void createNote()} className="btn-primary h-8 text-xs">+ 新建笔记</button>
                }
              />
            </div>
          ) : (
            <CollectionTable notes={tableNotes} />
          )
        ) : notes.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="✎"
              title="还没有笔记"
              hint="把会议之外的灵感记在这里；插入待办能从笔记直接挂到 OKR 体系。"
              action={
                <button onClick={() => void createNote()} className="btn-primary h-8 text-xs">+ 新建笔记</button>
              }
            />
          </div>
        ) : (
          <ul className="card divide-y divide-line">
            {notes.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => goNote(n.id)}
                  className="w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-bg-overlay/40 transition-colors"
                >
                  <span className="text-base">
                    {n.meeting_id ? '◆' : n.pinned ? '▣' : '✎'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-1 truncate">{n.title || '未命名笔记'}</div>
                    <div className="text-[11px] text-text-3 truncate mt-0.5">
                      {n.body_md ? n.body_md.replace(/<!--[\s\S]*?-->/g, '').replace(/[#>*_`\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '空白'}
                    </div>
                  </div>
                  <span className="text-[11px] text-text-3 shrink-0">{fmtDateTime(n.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}