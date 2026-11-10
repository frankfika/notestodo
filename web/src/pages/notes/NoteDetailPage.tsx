import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Editor } from '@tiptap/react'
import { useUI } from '../../state/ui'
import { db } from '../../db/db'
import { fmtDateTime, now } from '../../lib/id'
import type { Todo, ID } from '../../types'
import EmptyState from '../../components/EmptyState'
import OverflowMenu from '../../components/OverflowMenu'
import NoteEditor from '../../components/editor/NoteEditor'
import { NoteAiPanel } from '../../components/editor/NoteAiPanel'
import TagPicker from '../../components/TagPicker'
import { useToast } from '../../state/toast'

/**
 * 单条笔记：Notion 风格块编辑器（TipTap）+ 顶部工具栏 + 关联任务。
 * 顶部「插入待办」—— 创建 Todo{ source:'note', origin_note_id:this.id }，
 * 标题取编辑器内选中的文本。
 */
export default function NoteDetailPage(): JSX.Element {
  const noteId = useUI((s) => s.noteId)
  const goNotes = useUI((s) => s.goNotes)
  const goNote = useUI((s) => s.goNote)
  const goMeeting = useUI((s) => s.goMeeting)
  const goTodos = useUI((s) => s.goTodos)
  const { show } = useToast()
  const note = useLiveQuery(
    async () => {
      const n = noteId ? await db.notes.get(noteId) : undefined
      return n && n.deleted_at === null ? n : undefined
    },
    [noteId ?? ''],
  )
  const originMeeting = useLiveQuery(
    async () => note?.meeting_id ? await db.meetings.get(note.meeting_id) : undefined,
    [note?.meeting_id ?? ''],
  )
  const notebooks = useLiveQuery(
    () => db.notebooks.filter((nb) => nb.deleted_at === null).sortBy('sort_order'),
    [],
  ) ?? []
  // [[双链]] 跳转目标：按标题找笔记（重名取最近更新）
  const allNotes = useLiveQuery(() => db.notes.toArray(), []) ?? []
  const openWiki = useCallback((title: string): void => {
    const hit = [...allNotes]
      .filter((n) => n.deleted_at === null && n.title.trim() === title.trim())
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
    if (hit) goNote(hit.id)
  }, [allNotes, goNote])
  // 反向链接：其它笔记正文里 [[这篇的标题]]（含 [[标题|别名]] 写法）
  // 依赖只取标题/ id —— 原来挂整个 note 对象，自动保存每次都新对象 → 全表正文重扫一遍
  const noteTitle = note?.title?.trim() ?? ''
  const curNoteId = note?.id ?? ''
  const backlinks = useMemo(() => {
    if (!noteTitle || !curNoteId) return []
    const re = new RegExp(`\\[\\[${noteTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\]\\]|\\|)`)
    return allNotes.filter((n) => n.id !== curNoteId && n.deleted_at === null && re.test(n.body_md ?? ''))
  }, [allNotes, noteTitle, curNoteId])

  const [draftBody, setDraftBody] = useState<string>('')
  const [draftTitle, setDraftTitle] = useState<string>('')
  // 正文只有在本会话里被编辑器 onUpdate 触过才允许落盘——
  // 防止编辑器尚未灌入内容时（异步竞态）把空串覆盖掉已有正文
  const bodyTouchedRef = useRef(false)
  const [aiOpen, setAiOpen] = useState(false)
  const editorRef = useRef<Editor | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  // 面包屑：笔记本 › 父页 › … › 当前页（打通侧栏树与详情页）
  const allById = useMemo(() => new Map(allNotes.map((n) => [n.id, n])), [allNotes])
  const parentId = note?.parent_id ?? null
  const notebookId = note?.notebook_id ?? null
  const crumbs = useMemo(() => {
    if (!note) return []
    const chain: { id?: string; label: string }[] = []
    const nb = notebooks.find((x) => x.id === notebookId)
    if (nb) chain.push({ label: `${nb.icon} ${nb.name}` })
    let p = parentId
    const seen = new Set<string>()
    const parents: { id: string; label: string }[] = []
    while (p && !seen.has(p)) {
      seen.add(p)
      const pn = allById.get(p)
      if (!pn) break
      parents.unshift({ id: pn.id, label: pn.title || '无标题' })
      p = pn.parent_id ?? null
    }
    return [...chain, ...parents]
  }, [note?.id, parentId, notebookId, allById, notebooks])

  useEffect(() => {
    bodyTouchedRef.current = false
    setDraftBody(note?.body_md ?? '')
    setDraftTitle(note?.title ?? '')
    // 只在打开笔记时灌一次草稿；保存回写引起的 body_md 变化不回灌，
    // 否则「保存期间继续输入」的末尾字符既不落盘也不标脏（丢字窗口）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id])

  // 空页邀请：全新页面打开即聚焦标题（无向导），正文占位符引导输入 /
  useEffect(() => {
    if (note && !note.title && !note.body_md) titleRef.current?.focus()
  }, [note?.id])

  const dirty = !!note && (draftBody !== note.body_md || draftTitle !== note.title)

  // debounce 存盘；pendingRef 记录未落盘的草稿，切换/卸载时 flush（不丢末尾输入）
  const pendingRef = useRef<{ id: string; title: string; body: string } | null>(null)
  useEffect(() => {
    if (!note || !dirty) {
      pendingRef.current = null
      return
    }
    pendingRef.current = { id: note.id, title: draftTitle, body: draftBody }
    const t = setTimeout(() => {
      pendingRef.current = null
      void saveNoteFields(note.id, draftTitle, draftBody)
    }, 400)
    return () => clearTimeout(t)
  }, [draftBody, draftTitle, note?.id])

  // 切换笔记 / 离开页面时把 pending 的草稿立即落盘
  useEffect(() => () => {
    const p = pendingRef.current
    if (p) {
      pendingRef.current = null
      void saveNoteFields(p.id, p.title, p.body)
    }
  }, [note?.id])

  const linkedTodos = useLiveQuery(
    async () => noteId
      ? (await db.todos.where('origin_note_id').equals(noteId).toArray())
          // 软删除的 todo 不应继续挂在笔记「关联任务」里
          .filter((t) => t.deleted_at === null)
      : [],
    [noteId ?? ''],
  ) ?? []

  // 可挂到本笔记的已有任务：全部 open 任务（已挂在别篇的标注出来，选了改挂）
  const linkableTodos = useLiveQuery(
    async () => noteId
      ? (await db.todos.toArray()).filter(
          (t) => t.deleted_at === null && t.status === 'open' && t.origin_note_id !== noteId,
        )
      : [],
    [noteId ?? ''],
  ) ?? []

  const comments = useLiveQuery(
    async () => noteId
      ? (await db.comments.where('note_id').equals(noteId).sortBy('created_at'))
          .filter((c) => c.deleted_at === null)
      : [],
    [noteId ?? ''],
  ) ?? []

  async function addComment(quote: string, text: string): Promise<void> {
    if (!note) return
    const ts = now()
    await db.comments.add({
      id: crypto.randomUUID(), note_id: note.id, quote, text, resolved: false,
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
  }

  // 正文防误清空：只有编辑器 onUpdate 真正触过（bodyTouchedRef）才写 body_md；
  // 否则只存标题——编辑器尚未灌入内容时的竞态不再能把正文抹成空串
  function saveNoteFields(id: ID, title: string, body: string): void {
    const allowBody = bodyTouchedRef.current
    void db.notes.update(id, allowBody
      ? { title, body_md: body, updated_at: now() }
      : { title, updated_at: now() })
  }

  /** 扫描正文 `- [ ]` 行批量建任务；按标题去重保证幂等 */
  async function importChecklistTodos(): Promise<void> {
    if (!note) return
    const re = /^\s*[-*]\s*\[ \]\s+(.+)$/gm
    const existing = new Set(linkedTodos.map((t) => t.title.trim()))
    const titles: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(draftBody)) !== null) {
      const title = m[1].trim()
      if (title && !existing.has(title) && !titles.includes(title)) titles.push(title)
    }
    if (titles.length === 0) return
    const ts = now()
    for (const title of titles) {
      await db.todos.add({
        id: crypto.randomUUID(), kind: 'task', scope: null, parent_id: null, title,
        status: 'open', source: 'note', origin_note_id: note.id,
        sort_order: Date.now(), created_at: ts, updated_at: ts,
        deleted_at: null, sync_version: 0,
      })
    }
  }

  async function insertTodo(): Promise<void> {
    if (!note) return
    // 取编辑器内的选中文本
    const ed = editorRef.current
    const sel = ed?.state.selection
    const text = ed && sel && !sel.empty
      ? ed.state.doc.textBetween(sel.from, sel.to, '\n').trim()
      : ''
    const title = text || '从笔记创建的任务'
    const todo: Todo = {
      id: crypto.randomUUID(),
      kind: 'task',
      scope: null,
      parent_id: null,
      title,
      notes_md: undefined,
      status: 'open',
      source: 'note',
      meeting_id: undefined,
      origin_note_id: note.id,
      sort_order: Date.now(),
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
      sync_version: 0,
    }
    await db.todos.add(todo)
  }

  /** 软删 + 可撤销：子页提升到被删页的父级；关联任务/评论保留，笔记可从备份恢复 */
  async function deleteNote(): Promise<void> {
    if (!note) return
    const ts = now()
    const parentId = note.parent_id ?? null
    // 子页会上移一层 —— 先记下被挪走的是哪些页，撤销时原样挂回来
    const childIds = await db.notes.where('parent_id').equals(note.id).primaryKeys()
    await db.notes.where('parent_id').equals(note.id).modify((x) => {
      x.parent_id = parentId
      x.updated_at = ts
      x.sync_version += 1
    })
    await db.notes.update(note.id, { deleted_at: ts, updated_at: ts, sync_version: note.sync_version + 1 })
    show('已删除笔记', {
      label: '撤销',
      onClick: () => {
        void (async () => {
          const ts2 = now()
          const cur = await db.notes.get(note.id)
          if (cur) await db.notes.update(note.id, { deleted_at: null, updated_at: ts2, sync_version: cur.sync_version + 1 })
          if (childIds.length) {
            await db.notes.where('id').anyOf(childIds).modify((x) => {
              x.parent_id = note.id
              x.updated_at = ts2
              x.sync_version += 1
            })
          }
        })()
      },
    }, 6000)
    goNotes()
  }

  async function togglePin(): Promise<void> {
    if (!note) return
    await db.notes.update(note.id, { pinned: !note.pinned, updated_at: now() })
  }

  /** 块「移动到…」：编辑器已删除块并给出其 markdown，这里追加进目标页面 */
  async function moveBlockToNote(blockMd: string, targetId: string): Promise<void> {
    const target = await db.notes.get(targetId)
    if (!target || !blockMd.trim()) return
    await db.notes.update(targetId, {
      body_md: (target.body_md ? target.body_md.replace(/\s+$/, '') + '\n\n' : '') + blockMd.trim(),
      updated_at: now(),
    })
  }

  if (!noteId || !note) {
    return (
      <div className="h-full flex items-center justify-center">
        <EmptyState
          icon="◐"
          title="没有选中的笔记"
          action={<button onClick={goNotes} className="btn-outline h-8 text-xs">→ 笔记列表</button>}
        />
      </div>
    )
  }

  const lastSaved = fmtDateTime(note.updated_at)

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[740px] mx-auto px-10 md:px-16 pt-4 pb-24">
        {/* 面包屑：笔记本 › 父页 › 当前页 */}
        {crumbs.length > 0 && (
          <nav className="flex items-center gap-1 mb-1 text-[12px] text-text-3 -ml-1">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-text-disabled">›</span>}
                {c.id ? (
                  <button onClick={() => goNote(c.id!)} className="hover:text-text-1 hover:underline rounded px-0.5">{c.label}</button>
                ) : (
                  <span className="px-0.5">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}

        {/* 顶部工具栏：Notion 式轻量行 */}
        <div className="flex items-center gap-1 mb-6 -ml-2 text-text-3">
          <button onClick={goNotes} className="icon-btn" aria-label="返回">←</button>
          <span className="flex-1" />
          <span className="text-[12px] mr-1">
            {dirty ? '编辑中…' : `已存 ${lastSaved}`}
          </span>
          <button
            onClick={() => setAiOpen((v) => !v)}
            className={`btn-ghost text-xs h-7 ${aiOpen ? 'text-accent' : ''}`}
            title="AI 面板"
          >✦ AI</button>
          <button
            onClick={() => void togglePin()}
            className={`btn-ghost text-xs h-7 ${note.pinned ? 'text-accent' : ''}`}
            title="置顶"
          >{note.pinned ? '已置顶' : '置顶'}</button>
          <button onClick={() => void insertTodo()} className="btn-ghost text-xs h-7 whitespace-nowrap shrink-0" title="基于编辑器中选中的文字新建一条 Task">
            + 插入待办
          </button>
          <OverflowMenu items={[{ label: '删除笔记', danger: true, onClick: () => void deleteNote() }]} />
        </div>

        {/* 页面标题：Notion 式大字；左侧 chip 切换所属笔记本 */}
        <div className="flex items-start gap-2 mb-2">
          {notebooks.length > 0 && (
            <select
              value={note.notebook_id ?? ''}
              onChange={(e) => void db.notes.update(note.id, { notebook_id: e.target.value || null, updated_at: now() })}
              className="chip mt-4 shrink-0 cursor-pointer bg-transparent outline-none max-w-[140px]"
              title="所属笔记本"
            >
              <option value="">未分配</option>
              {notebooks.map((nb) => (
                <option key={nb.id} value={nb.id}>{nb.icon} {nb.name}</option>
              ))}
            </select>
          )}
          <input
            ref={titleRef}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="无标题"
            className="flex-1 min-w-0 bg-transparent text-[38px] leading-[1.2] font-bold text-text-1 outline-none placeholder:text-text-3/70"
          />
        </div>

        {/* 标签：键入即建，回车绑定；列表页可按 tag 筛 */}
        <div className="mb-3 -ml-1">
          <TagPicker targetType="note" targetId={note.id} />
        </div>

        {/* 块编辑器（所见即所得，替代原 textarea + 预览分栏） */}
        <NoteEditor
          key={note.id}
          initialMarkdown={note.body_md}
          onChange={(md) => { bodyTouchedRef.current = true; setDraftBody(md) }}
          onReady={(ed) => { editorRef.current = ed }}
          onWikiOpen={openWiki}
          currentNoteId={note.id}
          onMoveBlockToNote={(md, targetId) => void moveBlockToNote(md, targetId)}
          onAddComment={(quote, text) => void addComment(quote, text)}
        />

        {/* 关联：任务 / 来源会议 / 反向链接 —— 空区块默认折叠成一行，有内容自动展开 */}
        <div className="mt-10 border-t border-line pt-3 space-y-1">
          {originMeeting && (
            <div className="flex items-center gap-2 px-1 py-1">
              <span className="section-title">来源</span>
              <button onClick={() => goMeeting(originMeeting.id)} className="chip hover:text-accent" title="打开来源会议">
                会议 · {originMeeting.title}
              </button>
            </div>
          )}
          <CollapsibleSection
            title="从这条笔记创建的任务"
            count={linkedTodos.length}
            actions={
              <>
                <button
                  onClick={() => void importChecklistTodos()}
                  className="btn-ghost text-[11px] h-6 px-2"
                  title="把正文里所有 - [ ] 待办行导入为任务（已导入过的按标题跳过）"
                >导入正文待办</button>
                {linkableTodos.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      const id = e.target.value
                      if (id && note) void db.todos.update(id, { origin_note_id: note.id, updated_at: now() })
                    }}
                    className="chip cursor-pointer bg-transparent outline-none text-[11px] max-w-[150px]"
                    title="把一条已有任务关联到本笔记"
                  >
                    <option value="">关联已有任务…</option>
                    {linkableTodos.map((t) => {
                      const other = t.origin_note_id ? allNotes.find((n) => n.id === t.origin_note_id) : null
                      return (
                        <option key={t.id} value={t.id}>
                          {t.title}{other ? `（现挂《${other.title || '无标题'}》）` : ''}
                        </option>
                      )
                    })}
                  </select>
                )}
              </>
            }
          >
            {linkedTodos.length === 0 ? (
              <div className="text-xs text-text-3 px-1 py-1">选中正文片段 →「+ 插入待办」，或点「导入正文待办」。</div>
            ) : (
              <ul className="card divide-y divide-line">
                {linkedTodos.map((t) => (
                  <li key={t.id} className="px-4 py-2.5 text-sm flex items-center gap-2 group">
                    <input
                      type="checkbox"
                      checked={t.status === 'done'}
                      onChange={() => void db.todos.update(t.id, {
                        status: t.status === 'done' ? 'open' : 'done',
                        updated_at: now(), sync_version: t.sync_version + 1,
                      })}
                      className="shrink-0 accent-[var(--accent)]"
                    />
                    <button
                      onClick={() => goTodos(t.id)}
                      title="在任务树中定位"
                      className={`flex-1 text-left truncate hover:text-accent transition-colors ${t.status === 'done' ? 'line-through text-text-3' : 'text-text-1'}`}
                    >{t.title}</button>
                    <span className="chip">{t.status === 'done' ? '已完成' : t.status === 'pending_review' ? '待确认' : '进行中'}</span>
                    <button
                      className="btn-ghost text-[11px] h-6 px-2 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="解除与本笔记的关联（任务保留）"
                      onClick={() => void db.todos.where('id').equals(t.id).modify((x) => { delete x.origin_note_id; x.updated_at = now() })}
                    >解除</button>
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleSection>

          <CollapsibleSection title="评论" count={comments.filter((c) => !c.resolved).length}>
            {comments.length === 0 ? (
              <div className="text-xs text-text-3 px-1 py-1">hover 任意块 → ⋮⋮ → 评论。</div>
            ) : (
              <ul className="divide-y divide-line">
                {comments.map((c) => (
                  <li key={c.id} className={`py-2.5 ${c.resolved ? 'opacity-50' : ''}`}>
                    <div className="text-[11px] text-text-3 truncate border-l-2 border-line pl-2 mb-1">「{c.quote}」</div>
                    <div className="flex items-start gap-2">
                      <span className="flex-1 text-sm text-text-1 whitespace-pre-wrap">{c.text}</span>
                      <button
                        className="btn-ghost text-[11px] h-6 px-2"
                        onClick={() => void db.comments.update(c.id, { resolved: !c.resolved, updated_at: now() })}
                      >{c.resolved ? '重开' : '解决'}</button>
                      <button
                        className="btn-ghost text-[11px] h-6 px-2 text-danger"
                        onClick={() => void db.comments.update(c.id, { deleted_at: now(), updated_at: now() })}
                      >删除</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleSection>

          <CollapsibleSection title="反向链接" count={backlinks.length}>
            {backlinks.length === 0 ? (
              <div className="text-xs text-text-3 px-1 py-1">在其它笔记里写 [[{note.title || '标题'}]] 即可挂上。</div>
            ) : (
              <ul className="card divide-y divide-line">
                {backlinks.map((n) => (
                  <li key={n.id}>
                    <button onClick={() => goNote(n.id)} className="w-full text-left px-4 py-2.5 text-sm text-text-1 hover:bg-bg-overlay">
                      {n.title || '无标题'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleSection>
        </div>
      </div>

      {/* AI 面板：右侧滑出抽屉 */}
      {aiOpen && (
        <aside className="fixed right-0 top-0 bottom-0 w-[320px] border-l border-line bg-bg-raise shadow-lg z-40">
          <NoteAiPanel
            noteTitle={draftTitle}
            getBodyMarkdown={() => draftBody}
            onInsert={(md) => setDraftBody((b) => (b ? b.replace(/\s+$/, '') + '\n\n' : '') + md)}
          />
        </aside>
      )}
    </div>
  )
}

/** 折叠区块：空（count=0）默认收成一行；有内容自动展开；点击标题手动切换。 */
function CollapsibleSection({ title, count, actions, children }: {
  title: string
  count: number
  actions?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? count > 0
  return (
    <div>
      <div className="flex items-center gap-1 -mx-1 px-1 rounded-[8px] hover:bg-bg-overlay transition-colors">
        <button
          onClick={() => setManual(!open)}
          className="flex items-center gap-1.5 flex-1 min-w-0 py-1.5 text-left"
          aria-expanded={open}
        >
          <span className={`text-text-3 text-[10px] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>▶</span>
          <span className="section-title !mb-0">{title} ({count})</span>
        </button>
        {actions}
      </div>
      {open && <div className="mt-1 mb-3">{children}</div>}
    </div>
  )
}
