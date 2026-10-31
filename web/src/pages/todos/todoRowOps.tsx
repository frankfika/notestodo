import { useEffect, useRef, useState } from 'react'
import { db } from '../../db/db'
import { now } from '../../lib/id'
import type { Todo } from '../../types'
import TagPicker from '../../components/TagPicker'

export async function renameTodo(t: Todo, title: string): Promise<void> {
  const v = title.trim()
  if (!v || v === t.title) return
  await db.todos.update(t.id, { title: v, updated_at: now(), sync_version: t.sync_version + 1 })
}

export async function setDue(t: Todo, due: string | null): Promise<void> {
  await db.todos.where('id').equals(t.id).modify((x) => {
    if (due) x.due_date = due
    else delete x.due_date
    x.updated_at = now()
    x.sync_version += 1
  })
}

export async function moveToRoot(t: Todo): Promise<void> {
  if (!t.parent_id) return
  await db.todos.update(t.id, { parent_id: null, updated_at: now(), sync_version: t.sync_version + 1 })
}

/** 自身 + 所有子孙 id（BFS，环防御靠每个 id 只入队一次） */
export function subtreeIds(root: Todo, all: Todo[]): string[] {
  const byParent = new Map<string, Todo[]>()
  for (const x of all) {
    if (x.parent_id) byParent.set(x.parent_id, [...(byParent.get(x.parent_id) ?? []), x])
  }
  const ids = [root.id]
  const seen = new Set(ids)
  for (let i = 0; i < ids.length; i++) {
    for (const c of byParent.get(ids[i]) ?? []) {
      if (!seen.has(c.id)) { seen.add(c.id); ids.push(c.id) }
    }
  }
  return ids
}

export async function softDeleteTree(t: Todo, all: Todo[]): Promise<void> {
  const ids = subtreeIds(t, all)
  const ts = now()
  await db.todos.where('id').anyOf(ids).modify((x) => {
    if (x.deleted_at === null) {
      x.deleted_at = ts
      x.updated_at = ts
      x.sync_version += 1
    }
  })
  await db.tagBindings.where('[target_type+target_id]').anyOf(ids.map((id): [string, string] => ['todo', id])).delete()
}

const itemCls = 'px-2 py-1.5 rounded-[6px] text-[13px] text-left text-text-1 hover:bg-bg-overlay transition-colors'

/** 双击标题 → 行内编辑（Enter/失焦保存，Esc 取消） */
export function EditableTitle({ t, className }: { t: Todo; className?: string }): JSX.Element {
  const [editing, setEditing] = useState(false)
  if (!editing) {
    return (
      <span onDoubleClick={() => setEditing(true)} className={className} title="双击改名">
        {t.title || '（无标题）'}
      </span>
    )
  }
  return (
    <input
      autoFocus
      defaultValue={t.title}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') { void renameTodo(t, e.currentTarget.value); setEditing(false) }
        if (e.key === 'Escape') setEditing(false)
      }}
      onBlur={(e) => { void renameTodo(t, e.target.value); setEditing(false) }}
      className="input flex-1 min-w-0 !h-6 !py-0 px-1 text-sm"
    />
  )
}

/** 行尾 ⋯ 菜单：截止日期 / 移到根级 / 删除（软删子树） */
export function TodoMenu({ t, all }: { t: Todo; all: Todo[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onEsc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const subs = subtreeIds(t, all).length - 1
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        title="更多操作"
        className="w-6 h-6 rounded-[6px] text-text-3 opacity-0 group-hover:opacity-100 hover:bg-bg-raise hover:text-text-1 transition-opacity"
      >⋯</button>
      {open && (
        <div
          className="card shadow-lg absolute right-0 top-7 z-50 w-48 p-1 flex flex-col gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          <label className="px-2 pt-1 text-[11px] text-text-3">标签</label>
          <div className="px-2 pb-1">
            <TagPicker targetType="todo" targetId={t.id} />
          </div>
          <label className="px-2 pt-1 text-[11px] text-text-3 border-t border-line">截止日期</label>
          <input
            type="date"
            value={t.due_date ?? ''}
            onChange={(e) => void setDue(t, e.target.value || null)}
            className="input mx-1 mb-1 !w-auto !h-7 text-xs"
          />
          {t.parent_id && (
            <button className={itemCls} onClick={() => { void moveToRoot(t); setOpen(false) }}>移到根级</button>
          )}
          <button
            className={`${itemCls} text-danger border-t border-line mt-0.5 pt-1.5 rounded-none rounded-b-[6px]`}
            onClick={() => {
              const name = t.title || '无标题'
              const msg = subs > 0 ? `删除「${name}」？它的 ${subs} 个子任务会一起删除。` : `删除「${name}」？`
              if (window.confirm(msg)) void softDeleteTree(t, all)
              setOpen(false)
            }}
          >删除</button>
        </div>
      )}
    </div>
  )
}
