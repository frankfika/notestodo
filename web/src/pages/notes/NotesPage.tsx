import { useLiveQuery } from 'dexie-react-hooks'
import { useUI } from '../../state/ui'
import { db } from '../../db/db'
import { fmtDateTime, now, uid } from '../../lib/id'
import type { Note } from '../../types'
import EmptyState from '../../components/EmptyState'

/**
 * 笔记列表：左侧全部笔记；右侧「新建笔记」按钮。
 * 会议纪要类型的 Note 也展示在列表里，但带 📌 标记。
 */
export default function NotesPage(): JSX.Element {
  const notes = useLiveQuery(
    () => db.notes.orderBy('updated_at').reverse().toArray(),
    [],
  ) ?? []
  const goNote = useUI((s) => s.goNote)

  async function createNote(): Promise<void> {
    const id = uid()
    const ts = now()
    const note: Note = {
      id,
      title: '未命名笔记',
      body_md: '',
      meeting_id: undefined,
      todo_ids: [],
      pinned: false,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
    }
    await db.notes.add(note)
    goNote(id)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-6 py-8">
        <div className="flex items-end justify-between mb-6">
          <div>
            <div className="section-title">NOTES</div>
            <h1 className="text-2xl font-semibold text-text-1 mt-1">笔记</h1>
          </div>
          <button onClick={() => void createNote()} className="btn-primary text-sm h-9 px-4">
            + 新建笔记
          </button>
        </div>

        {notes.length === 0 ? (
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
                    {n.meeting_id ? '📌' : n.pinned ? '📎' : '✎'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-1 truncate">{n.title || '未命名笔记'}</div>
                    <div className="text-[11px] text-text-3 truncate mt-0.5">
                      {n.body_md ? n.body_md.replace(/[#>*_`\-]/g, '').slice(0, 80) : '空白'}
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