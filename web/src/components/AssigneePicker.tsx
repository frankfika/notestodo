import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../db/db'
import { now } from '../lib/id'
import {
  LEVEL_LABEL,
  LEVEL_ORDER,
  personPath,
  readPeople,
  removePerson,
  resolvePerson,
  upsertPerson,
  visiblePeople,
  type Person,
  type PersonLevel,
} from '../lib/people'

export interface AssigneePickerProps {
  todoId: string
  /** 当前关联人（自由文本名字） */
  assignee?: string
  /** 只读：只显示 chip，不弹选择器 */
  readonly?: boolean
  onChange?: (name: string | undefined) => void
}

/**
 * 关联人选择器。
 *
 * 名单来自本地人员目录（多层级：部门 / 小组 / 个人），可以直接新建；
 * 内部人员默认不列出来（「含内部」才看得到）—— 管理人不对外。
 * 选中后写回 `Todo.assignee`（还是那个自由文本字段，老数据不受影响）。
 */
export default function AssigneePicker({ todoId, assignee, readonly, onChange }: AssigneePickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  const [includeInternal, setIncludeInternal] = useState(false)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<{ name: string; level: PersonLevel; parent_id: string; internal: boolean }>({
    name: '',
    level: 'person',
    parent_id: '',
    internal: false,
  })
  const ref = useRef<HTMLDivElement>(null)

  const refresh = async (): Promise<void> => setPeople(await readPeople())
  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people])
  const current = resolvePerson(assignee, people)
  const hasInternal = people.some((p) => p.internal)
  const shown = useMemo(() => {
    const list = visiblePeople(people, includeInternal)
    const q = query.trim().toLowerCase()
    const hit = q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list
    return LEVEL_ORDER.map((level) => ({
      level,
      items: hit.filter((p) => p.level === level),
    })).filter((g) => g.items.length > 0)
  }, [people, includeInternal, query])

  async function pick(name: string | undefined): Promise<void> {
    const t = await db.todos.get(todoId)
    if (!t) return
    await db.todos.update(todoId, {
      assignee: name,
      updated_at: now(),
      sync_version: t.sync_version + 1,
    })
    onChange?.(name)
    setOpen(false)
  }

  async function create(): Promise<void> {
    const name = draft.name.trim()
    if (!name) return
    await upsertPerson({
      name,
      level: draft.level,
      parent_id: draft.parent_id || null,
      internal: draft.internal,
    })
    await refresh()
    await pick(name)
    setCreating(false)
    setDraft({ name: '', level: 'person', parent_id: '', internal: false })
  }

  async function drop(id: string): Promise<void> {
    await removePerson(id)
    await refresh()
  }

  const chip = (
    <span
      className={
        assignee
          ? 'chip !py-0 !text-[11px] cursor-pointer hover:border-accent hover:text-accent transition-colors'
          : 'chip !py-0 !text-[11px] text-text-3 cursor-pointer hover:border-accent hover:text-accent transition-colors'
      }
    >
      {assignee ? `@${assignee}` : '+ 人'}
    </span>
  )

  if (readonly) {
    return assignee ? <span className="text-[11px] text-text-2 shrink-0">@{assignee}</span> : <></>
  }

  return (
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen((o) => !o)} title="关联人">
        {chip}
      </button>
      {open && (
        <div className="card shadow-lg absolute right-0 top-7 z-50 w-64 p-2 flex flex-col gap-1.5">
          <input
            className="input !h-7 text-xs"
            value={query}
            autoFocus
            placeholder="找个人 / 小组…"
            onChange={(e) => setQuery(e.target.value)}
          />

          {hasInternal && (
            <label className="flex items-center gap-1.5 text-[11px] text-text-3 px-1 select-none">
              <input
                type="checkbox"
                checked={includeInternal}
                onChange={(e) => setIncludeInternal(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              含内部人员（不对外）
            </label>
          )}

          <div className="max-h-56 overflow-auto flex flex-col gap-1">
            {shown.length === 0 && <div className="text-[11px] text-text-3 px-1">没有匹配的人</div>}
            {shown.map((group) => (
              <div key={group.level} className="flex flex-col gap-0.5">
                <div className="text-[10px] text-text-3 px-1">{LEVEL_LABEL[group.level]}</div>
                {group.items.map((p) => {
                  const path = personPath(p, byId)
                  const label = path.length > 1 ? path.slice(0, -1).join(' › ') : ''
                  return (
                    <div key={p.id} className="flex items-center gap-1 group">
                      <button
                        type="button"
                        data-person-name={p.name}
                        onClick={() => void pick(p.name)}
                        className={`flex-1 text-left text-xs px-1 py-0.5 rounded-[5px] hover:bg-bg-overlay ${
                          assignee === p.name ? 'text-accent' : 'text-text-1'
                        }`}
                      >
                        {p.name}
                        {label && <span className="text-[10px] text-text-3 ml-1">{label}</span>}
                        {p.internal && <span className="text-[10px] text-text-3 ml-1">内部</span>}
                        {p.role === 'manager' && !p.internal && <span className="text-[10px] text-text-3 ml-1">管理</span>}
                      </button>
                      <button
                        type="button"
                        aria-label={`删除 ${p.name}`}
                        onClick={() => void drop(p.id)}
                        className="text-text-3 hover:text-danger text-[11px] opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ✕
                      </button>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          {assignee && (
            <button
              type="button"
              onClick={() => void pick(undefined)}
              className="text-[11px] text-text-3 hover:text-danger text-left px-1 border-t border-line pt-1.5"
            >
              清除关联人
            </button>
          )}

          {creating ? (
            <div className="flex flex-col gap-1 border-t border-line pt-1.5">
              <input
                className="input !h-7 text-xs"
                placeholder="名字，如「王工」"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void create()
                  }
                }}
              />
              <div className="flex items-center gap-1">
                <select
                  className="input !h-7 text-xs flex-1"
                  value={draft.level}
                  onChange={(e) => setDraft({ ...draft, level: e.target.value as PersonLevel })}
                >
                  {LEVEL_ORDER.map((l) => (
                    <option key={l} value={l}>
                      {LEVEL_LABEL[l]}
                    </option>
                  ))}
                </select>
                <select
                  className="input !h-7 text-xs flex-1"
                  value={draft.parent_id}
                  onChange={(e) => setDraft({ ...draft, parent_id: e.target.value })}
                >
                  <option value="">（顶层）</option>
                  {people
                    .filter((p) => p.level !== 'person')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </div>
              <label className="flex items-center gap-1.5 text-[11px] text-text-3 px-1 select-none">
                <input
                  type="checkbox"
                  checked={draft.internal}
                  onChange={(e) => setDraft({ ...draft, internal: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                内部人员（不对外）
              </label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void create()}
                  className="chip !text-[11px] hover:border-accent hover:text-accent"
                >
                  建好并关联
                </button>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="text-[11px] text-text-3 hover:text-text-1"
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="text-[11px] text-text-3 hover:text-accent text-left px-1 border-t border-line pt-1.5"
            >
              + 新建人员
            </button>
          )}
        </div>
      )}
    </div>
  )
}
