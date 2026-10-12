import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useUI } from '../../state/ui'
import { db } from '../../db/db'
import { fmtDateTime, now } from '../../lib/id'
import type { Todo } from '../../types'
import MarkdownView from '../../components/MarkdownView'
import EmptyState from '../../components/EmptyState'
import OverflowMenu from '../../components/OverflowMenu'

/**
 * 单条笔记：左侧 Markdown 编辑器（纯 textarea，MVP），右侧渲染。
 * 顶部「插入待办」按钮 —— 创建一条 Todo{ source:'note', origin_note_id:this.id, status:'open' }。
 */
export default function NoteDetailPage(): JSX.Element {
  const noteId = useUI((s) => s.noteId)
  const goNotes = useUI((s) => s.goNotes)
  const note = useLiveQuery(
    async () => noteId ? await db.notes.get(noteId) : undefined,
    [noteId ?? ''],
  )

  const [draftBody, setDraftBody] = useState<string>('')
  const [draftTitle, setDraftTitle] = useState<string>('')

  useEffect(() => {
    setDraftBody(note?.body_md ?? '')
    setDraftTitle(note?.title ?? '')
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
    // 抓当前选中文本
    const sel = window.getSelection?.()?.toString().trim()
    const title = sel || '从笔记创建的任务'
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
          <button onClick={() => void insertTodo()} className="btn-primary text-xs h-8" title="从当前笔记新建一条 Task">
            + 插入待办
          </button>
          <OverflowMenu items={[{ label: '删除笔记', danger: true, onClick: () => void deleteNote() }]} />
        </div>

        {/* 分割编辑 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card p-4">
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder="# 标题&#10;&#10;开始写作……选中文字再点上方「插入待办」可基于选中片段建任务。"
              className="w-full min-h-[60vh] bg-transparent text-[15px] leading-[1.7] text-text-1 placeholder:text-text-3 outline-none resize-y font-mono"
              spellCheck={false}
            />
          </div>
          <div className="card p-5">
            <div className="section-title mb-3">预览</div>
            <MarkdownView source={draftBody} />
          </div>
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