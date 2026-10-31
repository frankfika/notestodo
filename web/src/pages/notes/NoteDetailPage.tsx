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
  const editorRef = useRef<Editor | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

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
      <div className="max-w-[1080px] mx-auto px-6 py-6">
        {/* 顶部工具栏 */}
        <div className="flex items-center gap-2 mb-4">
          <button onClick={goNotes} className="icon-btn -ml-2" aria-label="返回">←</button>
          <input
            ref={titleRef}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="无标题"
            className="flex-1 bg-transparent text-2xl font-semibold text-text-1 outline-none placeholder:text-text-3"
          />
          <span className="text-[11px] text-text-3">
            {dirty ? '编辑中…' : `已存 ${lastSaved}`}
          </span>
          <button
            onClick={() => void togglePin()}
            className={`btn-outline text-xs h-8 ${note.pinned ? 'text-accent border-accent/40' : ''}`}
            title="置顶"
          >{note.pinned ? '已置顶' : '置顶'}</button>
          <button onClick={() => void insertTodo()} className="btn-primary text-xs h-8" title="基于编辑器中选中的文字新建一条 Task">
            + 插入待办
          </button>
          <OverflowMenu items={[{ label: '删除笔记', danger: true, onClick: () => void deleteNote() }]} />
        </div>

        {/* 块编辑器（所见即所得，替代原 textarea + 预览分栏） */}
        <div className="card px-12 md:px-14 py-5">
          <NoteEditor
            key={note.id}
            initialMarkdown={note.body_md}
            onChange={setDraftBody}
            onReady={(ed) => { editorRef.current = ed }}
            onWikiOpen={openWiki}
            currentNoteId={note.id}
            onMoveBlockToNote={(md, targetId) => void moveBlockToNote(md, targetId)}
          />
        </div>

        {/* 关联：任务 / 来源会议 / 反向链接 */}
        <div className="mt-6">
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
    </div>
  )
}
