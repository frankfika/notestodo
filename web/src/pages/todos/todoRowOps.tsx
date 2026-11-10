import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { db } from '../../db/db'
import { now, thisFriday, uid } from '../../lib/id'
import type { Todo } from '../../types'
import TagPicker from '../../components/TagPicker'
import DateInput from '../../components/DateInput'
import { useToast } from '../../state/toast'
import { applyTodoStatus } from '../../lib/todoStatus'
import AssigneePicker from '../../components/AssigneePicker'
import { archiveTodo, unarchiveTodo } from '../../lib/todoStatus'

/* ────────────────────────────────────────────────────────────────
   任务行操作：单击即改 / 键盘流 / 快捷日期 / 可撤销删除
   设计对齐 Notion/飞书：点击即编辑、↑↓ 选行、Tab 升降级、
   删除先软删并给撤销窗口、常用日期一键选
   ──────────────────────────────────────────────────────────────── */

/** 行内编辑状态：当前哪一行在编辑（树/列表共用一份）。 */
interface EditCtl {
  editingId: string | null
  setEditing: (id: string | null) => void
}

export const useEditCtl = create<EditCtl>((set) => ({
  editingId: null,
  setEditing: (id) => set({ editingId: id }),
}))

/** 刚创建、还没命名的任务。Esc 取消时直接删掉，不留「（无标题）」空壳。 */
const freshIds = new Set<string>()
function markFresh(id: string): void { freshIds.add(id) }
function clearFresh(id: string): void { freshIds.delete(id) }

export async function renameTodo(t: Todo, title: string): Promise<void> {
  const v = title.trim()
  clearFresh(t.id)
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

export async function toggleTodo(t: Todo): Promise<void> {
  await applyTodoStatus(t, t.status === 'done' ? 'open' : 'done')
}

/** 自身 + 所有子孙 id（BFS，环防御靠每个 id 只入队一次） */
export function subtreeIds(root: Todo, all: Todo[]): string[] {
  const byParent = new Map<string, Todo[]>()
  for (const x of all) {
    if (!x.parent_id) continue
    const arr = byParent.get(x.parent_id)
    if (arr) arr.push(x)
    else byParent.set(x.parent_id, [x])
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

/** 软删整棵子树，返回快照供 undo（含 tag 绑定）。 */
export async function softDeleteTreeWithUndo(t: Todo, all: Todo[]): Promise<() => Promise<void>> {
  const ids = subtreeIds(t, all)
  const ts = now()
  // 快照：要恢复的 todo 状态 + 要恢复的 tagBindings 行
  const todosSnap = all.filter((x) => ids.includes(x.id)).map((x) => ({ ...x }))
  const bindingsSnap = await db.tagBindings.where('[target_type+target_id]').anyOf(ids.map((id): [string, string] => ['todo', id])).toArray()

  await db.todos.where('id').anyOf(ids).modify((x) => {
    if (x.deleted_at === null) {
      x.deleted_at = ts
      x.updated_at = ts
      x.sync_version += 1
    }
  })
  await db.tagBindings.where('[target_type+target_id]').anyOf(ids.map((id): [string, string] => ['todo', id])).delete()

  return async (): Promise<void> => {
    // 恢复 todo（保留删除时的 updated_at 使 sync 视为同一条），再恢复绑定
    for (const snap of todosSnap) {
      const cur = await db.todos.get(snap.id)
      if (cur) {
        await db.todos.update(snap.id, { deleted_at: null, updated_at: now(), sync_version: cur.sync_version + 1 })
      }
    }
    for (const b of bindingsSnap) {
      const cur = await db.tagBindings.get(b.id)
      if (!cur) {
        await db.tagBindings.add({ ...b, updated_at: now(), sync_version: b.sync_version + 1 })
      }
    }
  }
}

/* ── 新建 / 层级调整 ─────────────────────────────────────────────── */

/** 新建一条任务并直接进入编辑态。parent=null 即根级。 */
export async function createTodo(parent: Todo | null): Promise<string> {
  const ts = now()
  const id = uid()
  await db.todos.add({
    id, kind: 'task', parent_id: parent?.id ?? null, scope: parent?.scope ?? null,
    title: '', status: 'open', source: 'manual', sort_order: Date.now(),
    created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
  })
  markFresh(id)
  useEditCtl.getState().setEditing(id)
  return id
}

/** 在 t 紧后面插一条同级任务并进入编辑态（编辑框里回车连打）。 */
export async function createSibling(t: Todo): Promise<string> {
  const ts = now()
  const id = uid()
  await db.todos.add({
    id, kind: 'task', parent_id: t.parent_id ?? null, scope: t.scope ?? null,
    title: '', status: 'open', source: 'manual', sort_order: t.sort_order + 0.5,
    created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
  })
  markFresh(id)
  useEditCtl.getState().setEditing(id)
  return id
}

/** Tab：成为「上一个同级」的子任务。 */
export async function indentTodo(t: Todo, all: Todo[]): Promise<void> {
  const sibs = all
    .filter((x) => x.parent_id === t.parent_id && x.id !== t.id && x.deleted_at === null)
    .sort((a, b) => a.sort_order - b.sort_order)
  const prev = sibs.filter((x) => x.sort_order < t.sort_order).pop()
  if (!prev) return
  const kids = all.filter((x) => x.parent_id === prev.id && x.deleted_at === null)
  const order = kids.length ? Math.max(...kids.map((k) => k.sort_order)) + 10 : t.sort_order
  await db.todos.update(t.id, {
    parent_id: prev.id, sort_order: order, updated_at: now(), sync_version: t.sync_version + 1,
  })
}

/** Shift+Tab：从父任务里提出来，变成父任务的下一个兄弟。 */
export async function outdentTodo(t: Todo, all: Todo[]): Promise<void> {
  if (!t.parent_id) return
  const parent = all.find((x) => x.id === t.parent_id)
  if (!parent) return
  await db.todos.update(t.id, {
    parent_id: parent.parent_id ?? null, sort_order: parent.sort_order + 0.5,
    updated_at: now(), sync_version: t.sync_version + 1,
  })
}

/* ── 常用快捷日期 ─────────────────────────────────────────────── */
function offsetDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const QUICK_DATES: { label: string; get: () => string }[] = [
  { label: '今天', get: () => offsetDate(0) },
  { label: '明天', get: () => offsetDate(1) },
  { label: '后天', get: () => offsetDate(2) },
  { label: '本周五', get: () => thisFriday().slice(0, 10) },
]

const itemCls = 'px-2 py-1.5 rounded-[6px] text-[13px] text-left text-text-1 hover:bg-bg-overlay transition-colors'

/**
 * 单击标题 → 行内编辑。
 * 键盘：Enter 保存并新建同级（连打）/ Esc 取消（新建的空任务直接删）/ Tab 缩进 / Shift+Tab 提升。
 * `all` 传了就启用层级调整（只有大纲视图有层级）。
 */
export function EditableTitle({ t, className, all }: { t: Todo; className?: string; all?: Todo[] }): JSX.Element {
  const editing = useEditCtl((s) => s.editingId === t.id)
  const [draft, setDraft] = useState(t.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) { setDraft(t.title); inputRef.current?.select() }
  }, [editing, t.title])

  if (!editing) {
    return (
      <span
        onClick={() => useEditCtl.getState().setEditing(t.id)}
        className={`${className ?? ''} cursor-text select-none`}
        title="点击编辑"
      >
        {t.title || '（无标题）'}
      </span>
    )
  }

  const commit = async (): Promise<void> => {
    const v = draft.trim()
    if (v) await renameTodo(t, v)
    else clearFresh(t.id)
  }

  const cancel = async (): Promise<void> => {
    // 新建还没命名的任务 → Esc 直接丢掉，不留空壳
    if (freshIds.has(t.id)) {
      freshIds.delete(t.id)
      await db.todos.delete(t.id)
    }
    useEditCtl.getState().setEditing(null)
  }

  return (
    <input
      ref={inputRef}
      autoFocus
      value={draft}
      placeholder="任务标题"
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Enter') {
          e.preventDefault()
          void (async () => {
            await commit()
            useEditCtl.getState().setEditing(null)
            if (all) await createSibling(t) // 回车即新建同级，光标接上（飞书/Notion 连打）
          })()
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          void cancel()
          return
        }
        if (e.key === 'Tab' && all) {
          e.preventDefault()
          void (async () => {
            await commit()
            if (e.shiftKey) await outdentTodo(t, all)
            else await indentTodo(t, all)
            // 节点在树里换了位置 → DOM 移动会丢焦点，重新抓回来
            setTimeout(() => {
              document.querySelector<HTMLInputElement>(`[data-todo="${t.id}"] input`)?.focus()
            }, 0)
          })()
        }
      }}
      onBlur={(e) => {
        void (async () => {
          const v = e.target.value.trim()
          if (v) await renameTodo(t, v)
          else if (freshIds.has(t.id)) {
            freshIds.delete(t.id)
            await db.todos.delete(t.id)
          }
          useEditCtl.getState().setEditing(null)
        })()
      }}
      className="input flex-1 min-w-0 !h-6 !py-0 px-1 text-sm"
    />
  )
}

/**
 * 列表键盘流：↑↓ 选行 / Enter 编辑 / Space 完成 / ⌫ 删除（带撤销）。
 * 焦点管理用 roving tabindex：容器里只有一个行可 Tab 进入，↑↓ 在行间移动。
 */
export function useRowKeys(
  containerRef: React.RefObject<HTMLElement | null>,
  all: Todo[],
  /** 只读模式（脑图开启时的大纲）：仅保留上下键导航，不允许编辑/完成/删除 */
  readOnly = false,
): React.KeyboardEventHandler<HTMLDivElement> {
  const { show } = useToast()
  return useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    // 输入框 / 按钮自己处理按键，不抢
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.isContentEditable) return
    const rowEl = target.closest<HTMLElement>('[data-todo]')
    if (!rowEl) return
    const id = rowEl.dataset.todo
    const todo = all.find((t) => t.id === id)
    if (!todo || !id) return

    const rows = (): HTMLElement[] =>
      Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-todo]') ?? [])

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const list = rows()
      const i = list.indexOf(rowEl)
      const next = e.key === 'ArrowDown' ? list[i + 1] : list[i - 1]
      next?.focus()
      return
    }
    if (readOnly) return // 只读：除了上下键导航，其余编辑键一律不接管
    if (e.key === 'Enter') {
      e.preventDefault()
      useEditCtl.getState().setEditing(id)
      return
    }
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault()
      void toggleTodo(todo)
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      const list = rows()
      const i = list.indexOf(rowEl)
      void (async () => {
        const undo = await softDeleteTreeWithUndo(todo, all)
        show('已删除', { label: '撤销', onClick: () => void undo() }, 6000)
        // 删掉后焦点不能丢：落到下一行，没有就落上一行
        setTimeout(() => {
          const after = rows()
          ;(after[i] ?? after[i - 1])?.focus()
        }, 0)
      })()
    }
  }, [all, show, containerRef, readOnly])
}

/** 行尾 ⋯ 菜单：快捷日期 / 自定义日期 / 标签 / 移到根级 / 删除（可撤销） */
export function TodoMenu({ t, all }: { t: Todo; all: Todo[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { show } = useToast()

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

  const doArchive = async (): Promise<void> => {
    await archiveTodo(t)
    show('已归档', { label: '撤销', onClick: () => void unarchiveTodo(t) }, 6000)
    setOpen(false)
  }

  const doDelete = async (): Promise<void> => {
    const undo = await softDeleteTreeWithUndo(t, all)
    show('已删除', { label: '撤销', onClick: () => void undo() }, 6000)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        title="更多操作"
        className="hover-only w-6 h-6 rounded-[6px] text-text-3 opacity-0 group-hover:opacity-100 hover:bg-bg-raise hover:text-text-1 transition-opacity"
      >⋯</button>
      {open && (
        <div
          className="card shadow-lg absolute right-0 top-7 z-50 w-56 p-1 flex flex-col gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          <label className="px-2 pt-1 text-[11px] text-text-3">快捷日期</label>
          <div className="flex flex-wrap gap-1 px-2 pb-1">
            {QUICK_DATES.map((d) => (
              <button
                key={d.label}
                onClick={() => { void setDue(t, d.get()); setOpen(false) }}
                className="chip text-xs hover:border-accent hover:text-accent transition-colors"
              >{d.label}</button>
            ))}
          </div>

          <label className="px-2 pt-1 text-[11px] text-text-3 border-t border-line">自定义日期</label>
          <DateInput
            value={t.due_date ?? ''}
            onChange={(v) => void setDue(t, v || null)}
            className="input mx-1 mb-1 !w-auto !h-7 text-xs"
          />

          <label className="px-2 pt-1 text-[11px] text-text-3 border-t border-line">关联人</label>
          <div className="px-2 pb-1">
            <AssigneePicker todoId={t.id} assignee={t.assignee} />
          </div>

          <label className="px-2 pt-1 text-[11px] text-text-3 border-t border-line">标签</label>
          <div className="px-2 pb-1">
            <TagPicker targetType="todo" targetId={t.id} />
          </div>

          {/* 归档：这件事黄了 / 被否了 —— 关掉，但留下带时间的记录 */}
          {t.archived_at ? (
            <button className={itemCls} onClick={() => { void unarchiveTodo(t); setOpen(false) }}>
              取消归档
            </button>
          ) : (
            <button className={itemCls} onClick={() => { void doArchive() }}>归档（这件事黄了）</button>
          )}

          {t.parent_id && (
            <button className={itemCls} onClick={() => { void moveToRoot(t); setOpen(false) }}>移到根级</button>
          )}

          <button
            className={`${itemCls} text-danger border-t border-line mt-0.5 pt-1.5 rounded-none rounded-b-[6px]`}
            onClick={() => void doDelete()}
          >删除</button>
        </div>
      )}
    </div>
  )
}
