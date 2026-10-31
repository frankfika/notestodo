import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Editor } from '@tiptap/react'
import { useUI } from '../../state/ui'
import { db } from '../../db/db'
import { fmtDateTime, now } from '../../lib/id'
import type { Todo } from '../../types'
import EmptyState from '../../components/EmptyState'
import OverflowMenu from '../../components/OverflowMenu'
import NoteEditor from '../../components/editor/NoteEditor'
import { NoteAiPanel } from '../../components/editor/NoteAiPanel'

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
  const note = useLiveQuery(
    async () => noteId ? await db.notes.get(noteId) : undefined,
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
      .filter((n) => n.title.trim() === title.trim())
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
    if (hit) goNote(hit.id)
  }, [allNotes, goNote])
  // 反向链接：其它笔记正文里 [[这篇的标题]]（含 [[标题|别名]] 写法）
  const backlinks = useMemo(() => {
    const title = note?.title?.trim()
    if (!title || !note) return []
    const re = new RegExp(`\\[\\[${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\]\\]|\\|)`)
    return allNotes.filter((n) => n.id !== note.id && n.deleted_at === null && re.test(n.body_md ?? ''))
  }, [allNotes, note])

  const [draftBody, setDraftBody] = useState<string>('')
  const [draftTitle, setDraftTitle] = useState<string>('')
  const [aiOpen, setAiOpen] = useState(false)
  const editorRef = useRef<Editor | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  // 面包屑：笔记本 › 父页 › … › 当前页（打通侧栏树与详情页）
  const crumbs = useMemo(() => {
    if (!note) return []
    const byId = new Map(allNotes.map((n) => [n.id, n]))
    const chain: { id?: string; label: string }[] = []
    const nb = notebooks.find((x) => x.id === note.notebook_id)
    if (nb) chain.push({ label: `${nb.icon} ${nb.name}` })
    let p = note.parent_id ?? null
    const seen = new Set<string>()
    const parents: { id: string; label: string }[] = []
    while (p && !seen.has(p)) {
      seen.add(p)
      const pn = byId.get(p)
      if (!pn) break
      parents.unshift({ id: pn.id, label: pn.title || '无标题' })
      p = pn.parent_id ?? null
    }
    return [...chain, ...parents]
  }, [note, allNotes, notebooks])

  useEffect(() => {
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

  // debounce 存盘
  useEffect(() => {
    if (!note || !dirty) return
    const t = setTimeout(() => {
      void db.notes.update(note.id, {
        title: draftTitle,
        body_md: draftBody,
        updated_at: now(),
      })
    }, 400)
    return () => clearTimeout(t)
  }, [draftBody, draftTitle, note?.id])

  const linkedTodos = useLiveQuery(
    async () => noteId
      ? (await db.todos.where('origin_note_id').equals(noteId).toArray())
          // 软删除的 todo 不应继续挂在笔记「关联任务」里
          .filter((t) => t.deleted_at === null)
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
    // 同步冗余索引到 Note.todo_ids
    await db.notes.update(note.id, {
      todo_ids: [...(note.todo_ids ?? []), todo.id],
      updated_at: now(),
    })
  }

  async function deleteNote(): Promise<void> {
    if (!note) return
    if (!window.confirm('删除这条笔记？关联的 Todo 不会被删除，但会失去来源引用。')) return
    await db.notes.delete(note.id)
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
          <button onClick={() => void insertTodo()} className="btn-ghost text-xs h-7" title="基于编辑器中选中的文字新建一条 Task">
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

        {/* 块编辑器（所见即所得，替代原 textarea + 预览分栏） */}
        <NoteEditor
          key={note.id}
          initialMarkdown={note.body_md}
          onChange={setDraftBody}
          onReady={(ed) => { editorRef.current = ed }}
          onWikiOpen={openWiki}
          currentNoteId={note.id}
          onMoveBlockToNote={(md, targetId) => void moveBlockToNote(md, targetId)}
          onAddComment={(quote, text) => void addComment(quote, text)}
        />

        {/* 关联：任务 / 来源会议 / 反向链接 */}
        <div className="mt-10 border-t border-line pt-6">
          <div className="flex items-center gap-2 mb-2">
            <div className="section-title">关联</div>
            {originMeeting && (
              <button onClick={() => goMeeting(originMeeting.id)} className="chip hover:text-accent" title="打开来源会议">
                会议 · {originMeeting.title}
              </button>
            )}
          </div>
          <div className="section-title mb-2 mt-3">从这条笔记创建的任务 ({linkedTodos.length})</div>
          {linkedTodos.length === 0 ? (
            <div className="text-xs text-text-3 px-3 py-2">还没有。选中正文片段后点「+ 插入待办」可创建一条 Task。</div>
          ) : (
            <ul className="card divide-y divide-line">
              {linkedTodos.map((t) => (
                <li key={t.id} className="px-4 py-2.5 text-sm flex items-center gap-2">
                  <span className="text-text-3">·</span>
                  <span className={`flex-1 ${t.status === 'done' ? 'line-through text-text-3' : 'text-text-1'}`}>{t.title}</span>
                  <span className="chip">{t.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 评论：块手柄 ⋮⋮ → 评论 加的条目在这里集中看 */}
        <div className="mt-8">
          <div className="section-title mb-2">评论 ({comments.filter((c) => !c.resolved).length})</div>
          {comments.length === 0 ? (
            <div className="text-xs text-text-3 px-1 py-2">还没有评论。hover 任意块点 ⋮⋮ → 评论 即可添加。</div>
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
        </div>

        {/* 反向链接：哪些笔记 [[链]] 到这篇（Obsidian backlinks） */}
        <div className="mt-6">
          <div className="section-title mb-2">反向链接 ({backlinks.length})</div>
          {backlinks.length === 0 ? (
            <div className="text-xs text-text-3 px-3 py-2">还没有笔记链接到这篇。在其它笔记里写 [[{note.title || '标题'}]] 即可挂上。</div>
          ) : (
            <ul className="card divide-y divide-line">
              {backlinks.map((n) => (
                <li key={n.id}>
                  <button onClick={() => goNote(n.id)} className="w-full text-left px-4 py-2.5 text-sm text-text-1 hover:bg-bg-overlay">
                    {n.title || '未命名笔记'}
                  </button>
                </li>
              ))}
            </ul>
          )}
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
