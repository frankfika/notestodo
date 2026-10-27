import { useCallback, useEffect, useRef, useState } from 'react'
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
  const note = useLiveQuery(
    async () => noteId ? await db.notes.get(noteId) : undefined,
    [noteId ?? ''],
  )
  // [[双链]] 跳转目标：按标题找笔记（重名取最近更新）
  const allNotes = useLiveQuery(() => db.notes.toArray(), []) ?? []
  const openWiki = useCallback((title: string): void => {
    const hit = [...allNotes]
      .filter((n) => n.title.trim() === title.trim())
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
    if (hit) goNote(hit.id)
  }, [allNotes, goNote])

  const [draftBody, setDraftBody] = useState<string>('')
  const [draftTitle, setDraftTitle] = useState<string>('')
  const editorRef = useRef<Editor | null>(null)

  useEffect(() => {
    setDraftBody(note?.body_md ?? '')
    setDraftTitle(note?.title ?? '')
    // 编辑器按 note.id 重挂载，正文不回灌编辑器，draftBody 只作存盘基准
  }, [note?.id, note?.body_md, note?.title])

  const dirty = !!note && (draftBody !== note.body_md || draftTitle !== note.title)

  // debounce 存盘
  useEffect(() => {
    if (!note || !dirty) return
    const t = setTimeout(() => {
      void db.notes.update(note.id, {
        title: draftTitle || '未命名笔记',
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
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="标题"
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
          />
        </div>

        {/* 关联任务 */}
        <div className="mt-6">
          <div className="section-title mb-2">从这条笔记创建的任务 ({linkedTodos.length})</div>
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
      </div>
    </div>
  )
}
