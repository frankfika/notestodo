import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useUI } from '../../state/ui'
import { db } from '../../db/db'
import { fmtDateTime } from '../../lib/id'
import { createPage } from '../../lib/notes'
import type { Note } from '../../types'
import EmptyState from '../../components/EmptyState'
import CollectionTable from './CollectionTable'

/**
 * 全部页面管理视图：笔记本 tabs + tag 筛选；每行显示归属（笔记本 · 父页链）。
 * 层级编辑主入口是侧栏页面树，这里是「找得到、看得出归属」的平面视图。
 */
export default function NotesPage(): JSX.Element {
  const notesRaw = useLiveQuery(
    () => db.notes.orderBy('updated_at').reverse().toArray(),
    [],
  ) ?? []
  const notebooks = useLiveQuery(
    () => db.notebooks.filter((nb) => nb.deleted_at === null).sortBy('sort_order'),
    [],
  ) ?? []
  const noteBindings = useLiveQuery(
    () => db.tagBindings.where('target_type').equals('note').toArray(),
    [],
  ) ?? []
  const allTags = useLiveQuery(() => db.tags.toArray(), []) ?? []

  const byId = useMemo(() => new Map(notesRaw.map((n) => [n.id, n])), [notesRaw])
  const nbById = useMemo(() => new Map(notebooks.map((nb) => [nb.id, nb])), [notebooks])

  // 行的归属链：笔记本名 · 父 › 祖父…
  const pathOf = (n: Note): string => {
    const parts: string[] = []
    const nb = n.notebook_id ? nbById.get(n.notebook_id) : null
    if (nb) parts.push(nb.name)
    let p = n.parent_id ?? null
    const seen = new Set<string>()
    const parents: string[] = []
    while (p && !seen.has(p)) {
      seen.add(p)
      const pn = byId.get(p)
      if (!pn) break
      parents.unshift(pn.title || '无标题')
      p = pn.parent_id ?? null
    }
    return [...parts, ...parents].join(' · ')
  }

  const goNote = useUI((s) => s.goNote)
  const [view, setView] = useState<'list' | 'table'>('list')
  const [nbFilter, setNbFilter] = useState<string | 'all' | 'none'>('all')
  const [tagFilter, setTagFilter] = useState<string | null>(null)

  // 有打过 tag 的页面才显示 tag 筛选条
  const usedTagIds = useMemo(() => new Set(noteBindings.map((b) => b.tag_id)), [noteBindings])
  const usedTags = useMemo(() => allTags.filter((t) => usedTagIds.has(t.id)), [allTags, usedTagIds])
  const noteIdsByTag = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const b of noteBindings) {
      if (!m.has(b.tag_id)) m.set(b.tag_id, new Set())
      m.get(b.tag_id)!.add(b.target_id)
    }
    return m
  }, [noteBindings])

  const filtered = useMemo(() => {
    let list = notesRaw
    if (nbFilter === 'none') list = list.filter((n) => !n.notebook_id || !nbById.has(n.notebook_id))
    else if (nbFilter !== 'all') list = list.filter((n) => n.notebook_id === nbFilter)
    if (tagFilter) {
      const ids = noteIdsByTag.get(tagFilter)
      list = list.filter((n) => ids?.has(n.id))
    }
    return [...list].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0
    })
  }, [notesRaw, nbFilter, tagFilter, nbById, noteIdsByTag])

  // 表格视图只收自由页面（非会议笔记、未删除）
  const tableNotes = useMemo(
    () => filtered.filter((n) => !n.meeting_id && !n.deleted_at),
    [filtered],
  )

  async function createNote(): Promise<void> {
    goNote(await createPage(null, nbFilter !== 'all' && nbFilter !== 'none' ? nbFilter : null))
  }

  const emptyAction = (
    <button onClick={() => void createNote()} className="btn-primary h-8 text-xs">+ 新建笔记</button>
  )

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-6 py-8">
        <div className="flex items-end justify-between mb-4">
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

        {/* 笔记本 tabs */}
        {notebooks.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {([['all', '全部'], ...notebooks.map((nb) => [nb.id, `${nb.icon} ${nb.name}`] as const), ['none', '未分配']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setNbFilter(k)}
                className={`px-2.5 h-7 rounded-full text-xs border transition-colors ${
                  nbFilter === k ? 'bg-accent/10 border-accent text-accent' : 'border-line text-text-2 hover:bg-bg-overlay'
                }`}
              >{label}</button>
            ))}
          </div>
        )}

        {/* tag 筛选（有页面打过 tag 才显示） */}
        {usedTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {usedTags.map((t) => (
              <button
                key={t.id}
                onClick={() => setTagFilter(tagFilter === t.id ? null : t.id)}
                className={`px-2 h-6 rounded-md text-[11px] transition-colors ${
                  tagFilter === t.id ? 'bg-accent text-accent-contrast' : 'bg-bg-overlay text-text-2 hover:text-text-1'
                }`}
              >#{t.name}</button>
            ))}
          </div>
        )}

        {view === 'table' ? (
          tableNotes.length === 0 ? (
            <div className="card">
              <EmptyState icon="✎" title="这里还没有笔记" hint="换个笔记本或标签看看，或新建一条。" action={emptyAction} />
            </div>
          ) : (
            <CollectionTable notes={tableNotes} />
          )
        ) : filtered.length === 0 ? (
          <div className="card">
            <EmptyState icon="✎" title="这里还没有笔记" hint="换个筛选看看，或新建一条。" action={emptyAction} />
          </div>
        ) : (
          <ul className="card divide-y divide-line">
            {filtered.map((n) => {
              const path = pathOf(n)
              return (
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
                        {path && <span className="text-text-2">{path} · </span>}
                        {n.body_md ? n.body_md.replace(/<!--[\s\S]*?-->/g, '').replace(/[#>*_`\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) : '空白'}
                      </div>
                    </div>
                    <span className="text-[11px] text-text-3 shrink-0">{fmtDateTime(n.updated_at)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
