import { type JSX, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useUI } from '../../state/ui'
import { db } from '../../db/db'
import { fmtDateTime } from '../../lib/id'
import { createPage } from '../../lib/notes'
import EmptyState from '../../components/EmptyState'
import CollectionTable from './CollectionTable'

/**
 * 全部页面管理视图：笔记本 tabs + tag 筛选；每行显示归属（笔记本 · 父页链）。
 * 层级编辑主入口是侧栏页面树，这里是「找得到、看得出归属」的平面视图。
 */
export default function NotesPage(): JSX.Element {
  const notesRaw = useLiveQuery(
    async () => (await db.notes.orderBy('updated_at').reverse().toArray()).filter((n) => n.deleted_at === null),
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
  const tagNameById = useMemo(() => new Map(allTags.map((t) => [t.id, t.name])), [allTags])
  const tagNamesByNote = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const b of noteBindings) {
      const name = tagNameById.get(b.tag_id)
      if (!name) continue
      const arr = m.get(b.target_id)
      if (arr) arr.push(name)
      else m.set(b.target_id, [name])
    }
    return m
  }, [noteBindings, tagNameById])

  // 每行的归属链 + 正文预览：数据不变就不重算。
  // 原来这两件事在渲染里逐行现算（几百行 × 4 次正则 + 父链回溯），切个视图也要全量重烧一遍
  const rowMeta = useMemo(() => {
    const m = new Map<string, {
      path: string
      preview: string
      notebookLabel: string
      tagNames: string[]
      searchText: string
    }>()
    for (const n of notesRaw) {
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
      // 预览只取开头一小段再洗格式：原来三遍正则跑在全文上（长笔记每次渲染全量扫）
      const preview = n.body_md
        ? n.body_md.replace(/<!--[\s\S]*?-->/g, '').slice(0, 600)
            .replace(/[#>*_`\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
        : '空白'
      const path = [...parts, ...parents].join(' · ')
      const notebookLabel = nb?.name ?? '未分配'
      const tagNames = tagNamesByNote.get(n.id) ?? []
      m.set(n.id, {
        path,
        preview,
        notebookLabel,
        tagNames,
        searchText: [
          n.title,
          preview,
          n.body_md.slice(0, 1000),
          path,
          notebookLabel,
          tagNames.join(' '),
          n.meeting_id ? '会议纪要' : '文档页',
          n.pinned ? '置顶' : '',
        ].join('\n').toLowerCase(),
      })
    }
    return m
  }, [notesRaw, byId, nbById, tagNamesByNote])

  const goNote = useUI((s) => s.goNote)
  const [view, setView] = useState<'list' | 'table'>('list')
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'pages' | 'meetings' | 'pinned'>('all')
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
    const q = query.trim().toLowerCase()
    let list = notesRaw
    if (nbFilter === 'none') list = list.filter((n) => !n.notebook_id || !nbById.has(n.notebook_id))
    else if (nbFilter !== 'all') list = list.filter((n) => n.notebook_id === nbFilter)
    if (tagFilter) {
      const ids = noteIdsByTag.get(tagFilter)
      list = list.filter((n) => ids?.has(n.id))
    }
    if (scope === 'pages') list = list.filter((n) => !n.meeting_id)
    if (scope === 'meetings') list = list.filter((n) => !!n.meeting_id)
    if (scope === 'pinned') list = list.filter((n) => n.pinned)
    if (q) {
      list = list.filter((n) => rowMeta.get(n.id)?.searchText.includes(q))
    }
    return [...list].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0
    })
  }, [notesRaw, nbFilter, noteIdsByTag, query, rowMeta, scope, tagFilter, nbById])

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
  const activeFilterCount = Number(scope !== 'all') + Number(nbFilter !== 'all') + Number(tagFilter !== null) + Number(query.trim() !== '')

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[820px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-4">
          <div className="min-w-0">
            <div className="section-title">NOTES</div>
            <h1 className="text-2xl font-semibold text-text-1 mt-1">笔记</h1>
            <p className="mt-1 text-sm text-text-3">
              笔记多了以后，先靠搜索、范围和置顶把入口收窄，再进页面继续写。
            </p>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
            <div className="flex rounded-[10px] border border-line bg-bg-raise p-0.5 text-xs shrink-0">
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
            <button onClick={() => void createNote()} className="btn-primary text-sm h-9 px-4 flex-1 sm:flex-none">
              + 新建笔记
            </button>
          </div>
        </div>

        <div className="card mb-4 p-3 sm:p-3.5">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题、正文、笔记本或标签"
              className="input !h-10 flex-1 min-w-0 text-sm"
            />
            <div className="flex flex-wrap gap-1.5">
              {([
                ['all', '全部'],
                ['pages', '文档页'],
                ['meetings', '会议纪要'],
                ['pinned', '已置顶'],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setScope(k)}
                  className={`px-3 h-8 rounded-full text-xs border transition-colors ${
                    scope === k ? 'bg-accent/10 border-accent text-accent' : 'border-line text-text-2 hover:bg-bg-overlay'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-3">
            <span>{filtered.length} 篇匹配</span>
            {query.trim() && <span>关键词：{query.trim()}</span>}
            {activeFilterCount > 0 && (
              <button
                onClick={() => { setQuery(''); setScope('all'); setNbFilter('all'); setTagFilter(null) }}
                className="text-text-2 hover:text-accent transition-colors"
              >
                清空筛选
              </button>
            )}
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
              const meta = rowMeta.get(n.id)
              const path = meta?.path ?? ''
              return (
                <li key={n.id}>
                  <button
                    onClick={() => goNote(n.id)}
                    className="w-full flex items-start sm:items-center gap-3 px-4 sm:px-5 py-3.5 text-left hover:bg-bg-overlay/40 transition-colors"
                  >
                    <span className="text-base">
                      {n.meeting_id ? '◆' : n.pinned ? '▣' : '✎'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <div className="text-sm font-medium text-text-1 truncate max-w-full">{n.title || '无标题'}</div>
                        {n.pinned && <span className="px-1.5 h-5 inline-flex items-center rounded-full bg-accent/10 text-accent text-[10px]">置顶</span>}
                        {n.meeting_id && <span className="px-1.5 h-5 inline-flex items-center rounded-full bg-bg-overlay text-text-2 text-[10px]">会议</span>}
                        {(meta?.tagNames ?? []).slice(0, 2).map((name) => (
                          <span key={name} className="px-1.5 h-5 inline-flex items-center rounded-full bg-bg-overlay text-text-2 text-[10px]">
                            #{name}
                          </span>
                        ))}
                      </div>
                      <div className="text-[11px] text-text-3 truncate mt-0.5">
                        {path && <span className="text-text-2">{path} · </span>}
                        {meta?.preview ?? '空白'}
                      </div>
                      <div className="mt-1 text-[11px] text-text-3 sm:hidden">{fmtDateTime(n.updated_at)}</div>
                    </div>
                    <span className="hidden sm:inline text-[11px] text-text-3 shrink-0">{fmtDateTime(n.updated_at)}</span>
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
