import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import { fmtDate, now, thisFriday, today as todayIso, uid } from '../../lib/id'
import DateInput from '../../components/DateInput'
import type { Board, Tag, Todo } from '../../types'
import OriginChip from '../../components/OriginChip'
import TodoTags from '../todos/TodoTags'
import { buildTagByTodo } from '../todos/filter'
import { useOriginTitles, type OriginTitles } from '../../lib/originTitles'
import { useToast } from '../../state/toast'

const DONE_COL = '已完成'
const DEFAULT_COLS = ['待办', '进行中', '待审']
const DOTS = ['bg-text-3', 'bg-accent', 'bg-warning', 'bg-violet-500', 'bg-sky-500', 'bg-pink-500']
const LEGACY_COL: Record<string, string> = { todo: '待办', doing: '进行中', review: '待审' }

/** 没有 board 记录时自动建「默认看板」。确定性 id 防 StrictMode/并发双建；顺带清理历史重复的空白默认看板 */
async function ensureDefaultBoard(): Promise<void> {
  const ts = now()
  try {
    await db.boards.add({
      id: 'board-default', name: '默认看板', icon: '📋', columns: [...DEFAULT_COLS], sort_order: 0,
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
  } catch { /* 已存在 */ }
  // 历史 bug 清账：同名活跃「默认看板」超过一个时，卡片归并到第一个，空的软删
  const dups = (await db.boards.toArray()).filter((b) => b.deleted_at === null && b.name === '默认看板')
  if (dups.length > 1) {
    const [keep, ...rest] = dups.sort((a, b) => a.sort_order - b.sort_order)
    for (const b of rest) {
      const cards = await db.todos.where('board_id').equals(b.id).count()
      if (cards === 0) {
        await db.boards.update(b.id, { deleted_at: ts, updated_at: ts, sync_version: b.sync_version + 1 })
      } else {
        await db.todos.where('board_id').equals(b.id).modify({ board_id: keep.id })
        await db.boards.update(b.id, { deleted_at: ts, updated_at: ts, sync_version: b.sync_version + 1 })
      }
    }
  }
}

/** 每周自动出现的「写本周周报」循环卡。确定性 id 按周去重，天然幂等（StrictMode 双跑 / 并发都安全） */
async function ensureWeeklyReportCard(): Promise<void> {
  const due = thisFriday()
  const id = `weekly-report-${due}`
  const ts = now()
  const board = (await db.boards.orderBy('sort_order').first())
  try {
    await db.todos.add({
      id, kind: 'task', parent_id: null, scope: null, title: '写本周周报', status: 'open', source: 'manual',
      due_date: due, recurring: 'weekly-report', board_id: board?.id ?? null,
      board_col: board?.columns[0] ?? '待办', sort_order: Date.now(),
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
  } catch {
    // id 已存在 = 本周卡已建，忽略
  }
}

export default function BoardPage(): JSX.Element {
  const goTodos = useUI((s) => s.goTodos)
  const goReport = useUI((s) => s.goReport)
  const { show } = useToast()
  const [boardId, setBoardId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [showAllDone, setShowAllDone] = useState(false)

  useEffect(() => { void (async () => { await ensureDefaultBoard(); await ensureWeeklyReportCard() })() }, [])

  const boardsRaw = useLiveQuery(() => db.boards.orderBy('sort_order').toArray(), [])
  const boards = useMemo(() => (boardsRaw ?? []).filter((b) => !b.deleted_at), [boardsRaw])
  const board: Board | undefined = boards.find((b) => b.id === boardId) ?? boards[0]
  const cols = useMemo(() => [...(board?.columns ?? []), DONE_COL], [board])

  const all = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const byId = useMemo(() => new Map(all.map((t) => [t.id, t])), [all])
  const tags = useLiveQuery(() => db.tags.toArray(), []) ?? []
  const tagsById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])
  const bindings = useLiveQuery(() => db.tagBindings.toArray(), []) ?? []
  const tagByTodo = useMemo(() => buildTagByTodo(bindings), [bindings])

  const t0 = todayIso()
  const origins = useOriginTitles(all)
  const cards = useMemo(() => {
    if (!board) return []
    const isDefault = boards[0]?.id === board.id
    const doneCut = Date.now() - 14 * 86400_000 // 完成列只留最近两周，避免无限增长
    return all.filter((t) => {
      if (t.kind !== 'task' || t.deleted_at !== null) return false
      if (t.status === 'cancelled' || t.status === 'pending_review') return false
      if (t.status === 'done' && !showAllDone && Date.parse(t.updated_at) < doneCut) return false
      return t.board_id ? t.board_id === board.id : isDefault
    }).sort((a, b) => a.sort_order - b.sort_order)
  }, [all, board, boards, showAllDone])

  const olderDoneCount = useMemo(() => {
    if (!board || showAllDone) return 0
    const isDefault = boards[0]?.id === board.id
    const doneCut = Date.now() - 14 * 86400_000
    return all.filter((t) =>
      t.kind === 'task' && t.deleted_at === null && t.status === 'done' &&
      Date.parse(t.updated_at) < doneCut &&
      (t.board_id ? t.board_id === board.id : isDefault),
    ).length
  }, [all, board, boards, showAllDone])

  const colOf = (t: Todo): string => {
    if (t.status === 'done') return DONE_COL
    const c = t.board_col ?? ''
    if (board && board.columns.includes(c)) return c
    const legacy = LEGACY_COL[c]
    if (legacy && board?.columns.includes(legacy)) return legacy
    return board?.columns[0] ?? DONE_COL
  }

  // 卡片按列分组一次：原来每列都 cards.filter 一遍（列数 × 卡片数）
  const cardsByCol = useMemo(() => {
    const m = new Map<string, Todo[]>()
    for (const c of cols) m.set(c, [])
    for (const t of cards) {
      const c = colOf(t)
      const arr = m.get(c)
      if (arr) arr.push(t)
    }
    return m
  }, [cards, cols, board])

  const move = async (id: string, col: string): Promise<void> => {
    const t = byId.get(id)
    if (!t || colOf(t) === col) return
    await db.todos.update(id, {
      status: col === DONE_COL ? 'done' : 'open',
      board_id: board?.id ?? t.board_id,
      board_col: col === DONE_COL ? t.board_col : col,
      updated_at: now(), sync_version: t.sync_version + 1,
    })
  }

  const add = async (col: string, title: string): Promise<void> => {
    if (!board) return
    const ts = now()
    await db.todos.add({
      id: uid(), kind: 'task', parent_id: null, scope: null, title,
      status: col === DONE_COL ? 'done' : 'open', source: 'manual',
      board_id: board.id, board_col: col === DONE_COL ? undefined : col, sort_order: Date.now(),
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
  }

  const addBoard = async (): Promise<void> => {
    const name = window.prompt('新看板名称')?.trim()
    if (!name) return
    const ts = now()
    const id = uid()
    await db.boards.add({
      id, name, icon: '📋', columns: [...DEFAULT_COLS], sort_order: boards.length,
      created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0,
    })
    setBoardId(id)
  }

  const renameBoard = async (b: Board): Promise<void> => {
    const name = window.prompt('看板名称', b.name)?.trim()
    if (!name || name === b.name) return
    await db.boards.update(b.id, { name, updated_at: now(), sync_version: b.sync_version + 1 })
  }

  /** 删看板：软删看板，卡片回默认看板；撤销 = 恢复看板 + 把卡片挂回去 */
  const deleteBoard = async (b: Board): Promise<void> => {
    const ts = now()
    const cardIds = await db.todos.where('board_id').equals(b.id).primaryKeys()
    await db.todos.where('board_id').equals(b.id).modify((x) => {
      x.board_id = null
      x.updated_at = ts
      x.sync_version += 1
    })
    await db.boards.update(b.id, { deleted_at: ts, updated_at: ts, sync_version: b.sync_version + 1 })
    if (boardId === b.id) setBoardId(null)
    show(`已删除看板「${b.name}」`, {
      label: '撤销',
      onClick: () => {
        void (async () => {
          const ts2 = now()
          const cur = await db.boards.get(b.id)
          if (cur) await db.boards.update(b.id, { deleted_at: null, updated_at: ts2, sync_version: cur.sync_version + 1 })
          if (cardIds.length) {
            await db.todos.where('id').anyOf(cardIds).modify((x) => {
              x.board_id = b.id
              x.updated_at = ts2
              x.sync_version += 1
            })
          }
        })()
      },
    }, 6000)
  }

  const renameCol = async (col: string): Promise<void> => {
    if (!board) return
    const name = window.prompt('列名称', col)?.trim()
    if (!name || name === col || board.columns.includes(name)) return
    const ts = now()
    await db.boards.update(board.id, {
      columns: board.columns.map((c) => (c === col ? name : c)),
      updated_at: ts, sync_version: board.sync_version + 1,
    })
    await db.todos.filter((x) => x.board_id === board.id && x.board_col === col).modify((x) => {
      x.board_col = name
      x.updated_at = ts
      x.sync_version += 1
    })
  }

  /** 删列：列消失，卡片移到第一列；撤销 = 恢复列（连同顺序）+ 卡片回到该列 */
  const deleteCol = async (col: string): Promise<void> => {
    if (!board || board.columns.length <= 1) return
    const origCols = [...board.columns]
    const rest = origCols.filter((c) => c !== col)
    const ts = now()
    await db.boards.update(board.id, { columns: rest, updated_at: ts, sync_version: board.sync_version + 1 })
    const colCards = db.todos.where('board_id').equals(board.id).and((x) => x.board_col === col)
    const cardIds = await colCards.primaryKeys()
    await colCards.modify((x) => {
      x.board_col = rest[0]
      x.updated_at = ts
      x.sync_version += 1
    })
    show(`已删除列「${col}」`, {
      label: '撤销',
      onClick: () => {
        void (async () => {
          const ts2 = now()
          const cur = await db.boards.get(board.id)
          await db.boards.update(board.id, {
            columns: origCols,
            updated_at: ts2,
            sync_version: (cur?.sync_version ?? board.sync_version) + 1,
          })
          if (cardIds.length) {
            await db.todos.where('id').anyOf(cardIds).modify((x) => {
              x.board_col = col
              x.updated_at = ts2
              x.sync_version += 1
            })
          }
        })()
      },
    }, 6000)
  }

  const addColumn = async (): Promise<void> => {
    if (!board) return
    const name = window.prompt('新列名称')?.trim()
    if (!name || board.columns.includes(name)) return
    await db.boards.update(board.id, { columns: [...board.columns, name], updated_at: now(), sync_version: board.sync_version + 1 })
  }

  return (
    <div className="h-full flex flex-col px-6 md:px-10 pt-8 pb-6 gap-5 overflow-hidden">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <div className="section-title">任务 · 看板</div>
          <h1 className="text-2xl font-semibold tracking-tight">看板</h1>
        </div>
        <div className="ml-auto">
          <button onClick={() => useUI.getState().goTodos()} className="btn-ghost text-xs h-8 px-3">← 任务树</button>
        </div>
        <div className="w-full flex gap-2 overflow-x-auto">
          {boards.map((b) => (
            <div key={b.id} onClick={() => setBoardId(b.id)}
              className={`group flex items-center gap-0.5 pl-3 pr-1.5 h-7 rounded-full text-xs border whitespace-nowrap cursor-pointer transition-colors ${board?.id === b.id ? 'bg-accent/10 border-accent text-accent' : 'border-line text-text-2 hover:bg-bg-overlay'}`}>
              <span>{b.icon} {b.name}</span>
              <MiniMenu items={[
                { label: '重命名', onClick: () => void renameBoard(b) },
                { label: '删除看板', danger: true, onClick: () => void deleteBoard(b) },
              ]} />
            </div>
          ))}
          <button onClick={() => void addBoard()}
            className="px-3 h-7 rounded-full text-xs border border-dashed border-line text-text-3 hover:bg-bg-overlay whitespace-nowrap">
            ＋ 新建看板
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex gap-4 overflow-x-auto">
        {cols.map((c, ci) => {
          const list = cardsByCol.get(c) ?? []
          const isDone = c === DONE_COL
          return (
            <section key={c} data-testid={`board-col-${c}`}
              onDragOver={(e) => { e.preventDefault(); setOverCol(c) }}
              onDragLeave={() => setOverCol((o) => (o === c ? null : o))}
              onDrop={(e) => { e.preventDefault(); setOverCol(null); const id = e.dataTransfer.getData('text/plain') || dragId; if (id) void move(id, c); setDragId(null) }}
              className={`flex-1 min-w-[240px] flex flex-col rounded-2xl p-3 gap-2 bg-bg-overlay transition-shadow ${overCol === c ? 'ring-2 ring-accent/50' : ''}`}>
              <div className="group flex items-center gap-2 px-1 pb-1">
                <span className={`h-2 w-2 rounded-full ${isDone ? 'bg-emerald-600' : DOTS[ci % DOTS.length]}`} />
                <span className="text-[13px] font-semibold">{c}</span>
                <span className="text-xs text-text-3 tabular-nums">{list.length}</span>
                <span className="ml-auto" />
                {!isDone && (
                  <MiniMenu items={[
                    { label: '重命名列', onClick: () => void renameCol(c) },
                    { label: '删除列', danger: true, onClick: () => void deleteCol(c) },
                  ]} />
                )}
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
                {list.map((t) => (
                  <Card key={t.id} t={t} kr={t.parent_id ? byId.get(t.parent_id) : undefined}
                    overdue={!!t.due_date && t.due_date < t0 && t.status !== 'done'}
                    dimmed={dragId === t.id}
                    tagIds={tagByTodo.get(t.id) ?? []} tagsById={tagsById} origins={origins}
                    cols={cols} onMoveTo={(col) => void move(t.id, col)}
                    onDragStart={(e) => { setDragId(t.id); e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move' }}
                    onOpen={() => (t.recurring === 'weekly-report' ? goReport() : goTodos(t.id))} />
                ))}
                {list.length === 0 && <div className="text-xs text-text-3 text-center py-6">拖卡片到这里</div>}
                {isDone && olderDoneCount > 0 && (
                  <button
                    onClick={() => setShowAllDone(true)}
                    className="text-xs text-text-3 hover:text-accent text-center py-1.5 transition-colors"
                  >更早的 {olderDoneCount} 条已完成 · 展开</button>
                )}
                {isDone && showAllDone && (
                  <button
                    onClick={() => setShowAllDone(false)}
                    className="text-xs text-text-3 hover:text-accent text-center py-1.5 transition-colors"
                  >收起</button>
                )}
              </div>
              <QuickAdd onAdd={(title) => add(c, title)} />
            </section>
          )
        })}
        <button onClick={() => void addColumn()} data-testid="board-add-col"
          className="shrink-0 self-start min-w-[160px] rounded-2xl border border-dashed border-line text-text-3 text-sm py-3 hover:bg-bg-overlay hover:text-accent transition-colors">
          ＋ 添加列
        </button>
      </div>
    </div>
  )
}

interface MenuItem { label: string; danger?: boolean; onClick: () => void }

/** 看板卡片：checkbox 完成切换、单击改标题、⋯ 菜单（截止日期/完成/删除/跳任务树） */
function Card({ t, kr, overdue, dimmed, onDragStart, onOpen, tagIds, tagsById, cols, onMoveTo, origins }: {
  t: Todo; kr: Todo | undefined; overdue: boolean; dimmed: boolean
  onDragStart: (e: React.DragEvent) => void; onOpen: () => void
  tagIds: string[]; tagsById: Map<string, Tag>
  cols: string[]; onMoveTo: (col: string) => void
  origins: OriginTitles
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(t.title)
  const touch = (patch: Partial<Todo>): Promise<number> =>
    db.todos.update(t.id, { ...patch, updated_at: now(), sync_version: t.sync_version + 1 })

  const saveTitle = (): void => {
    const v = draft.trim()
    setEditing(false)
    if (v && v !== t.title) void touch({ title: v })
  }

  return (
    <article draggable={!editing} onDragStart={onDragStart}
      className={`card group p-3 hover:shadow-md transition-shadow ${t.recurring ? 'border-accent/60' : ''} ${dimmed ? 'opacity-40' : ''}`}>
      <div className="flex items-start gap-2">
        <input type="checkbox" checked={t.status === 'done'} title={t.status === 'done' ? '重开' : '完成'}
          onClick={(e) => e.stopPropagation()}
          onChange={() => void touch({ status: t.status === 'done' ? 'open' : 'done' })}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)] cursor-pointer" />
        {editing ? (
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) saveTitle()
              if (e.key === 'Escape') { setDraft(t.title); setEditing(false) }
            }}
            className="input flex-1 !py-0.5 text-sm" />
        ) : (
          <div onClick={(e) => { e.stopPropagation(); setDraft(t.title); setEditing(true) }}
            className={`flex-1 text-sm leading-snug cursor-text ${t.status === 'done' ? 'line-through text-text-3' : ''}`}>
            {t.recurring && <span className="text-accent mr-1">↻</span>}{t.title}
          </div>
        )}
        <CardMenu t={t} onTouch={touch} onOpen={onOpen} cols={cols} onMoveTo={onMoveTo}
          onRename={() => { setDraft(t.title); setEditing(true) }} />
      </div>
      <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[11px]">
        {kr && <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent truncate max-w-[140px]">{kr.title}</span>}
        {t.recurring && <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">草稿已生成</span>}
        <TodoTags ids={tagIds} tagsById={tagsById} />
        <OriginChip t={t}
          noteTitle={t.origin_note_id ? origins.noteTitles.get(t.origin_note_id) : undefined}
          meetingTitle={t.meeting_id ? origins.meetingTitles.get(t.meeting_id) : undefined} />
        {t.due_date && (
          <span className={`ml-auto ${t.status !== 'done' && overdue ? 'text-danger' : t.due_date === todayIso() && t.status !== 'done' ? 'text-warning' : 'text-text-3'}`}>
            {fmtDate(t.due_date)}
          </span>
        )}
      </div>
    </article>
  )
}

/** 卡片 ⋯ 菜单：含原生日期选择 + 移动到列（触屏拖拽的替代） */
function CardMenu({ t, onTouch, onOpen, onRename, cols, onMoveTo }: {
  t: Todo; onTouch: (patch: Partial<Todo>) => Promise<number>; onOpen: () => void; onRename: () => void
  cols: string[]; onMoveTo: (col: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { show } = useToast()
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const doDelete = async (): Promise<void> => {
    await onTouch({ deleted_at: now() })
    show('已删除卡片', {
      label: '撤销',
      onClick: () => void db.todos.update(t.id, { deleted_at: null, updated_at: now() }),
    }, 6000)
    setOpen(false)
  }

  const item = 'px-2 py-1.5 rounded-[6px] text-[13px] text-left hover:bg-bg-overlay transition-colors text-text-1 w-full'
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }} title="卡片操作"
        className="w-5 h-5 rounded-[5px] text-text-3 md:opacity-0 md:group-hover:opacity-100 hover:bg-bg-raise hover:text-text-1 text-xs leading-none transition-opacity">⋯</button>
      {open && (
        <div className="card shadow-lg absolute right-0 top-6 z-50 w-44 p-1 flex flex-col gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button className={item} onClick={() => { onRename(); setOpen(false) }}>重命名</button>
          <label className="px-2 py-1.5 text-[11px] text-text-3 flex items-center gap-2">
            截止日期
            <DateInput value={t.due_date ?? ''}
              onChange={(v) => void onTouch({ due_date: v || undefined })}
              className="input !h-6 !px-1.5 !py-0 text-[11px] flex-1" />
          </label>
          <button className={item} onClick={() => { void onTouch({ status: t.status === 'done' ? 'open' : 'done' }); setOpen(false) }}>
            {t.status === 'done' ? '标记为未完成' : '标记为已完成'}
          </button>
          <div className="px-2 pt-1.5 pb-0.5 text-[11px] text-text-3 border-t border-line/60 mt-1">移动到</div>
          {cols.map((col) => (
            <button key={col} className={item} onClick={() => { onMoveTo(col); setOpen(false) }}>→ {col}</button>
          ))}
          <button className={item} onClick={() => { onOpen(); setOpen(false) }}>在任务树中打开</button>
          <button className={`${item} text-danger`} onClick={() => void doDelete()}>删除</button>
        </div>
      )}
    </div>
  )
}

/** 行内 ⋯ 小菜单（hover 父级 .group 显现） */
function MiniMenu({ items }: { items: MenuItem[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        title="更多操作"
        className="w-5 h-5 rounded-[5px] text-text-3 opacity-0 group-hover:opacity-100 hover:bg-bg-raise hover:text-text-1 text-xs leading-none transition-opacity"
      >⋯</button>
      {open && (
        <div className="card shadow-lg absolute right-0 top-6 z-50 w-36 p-1 flex flex-col gap-0.5" onClick={(e) => e.stopPropagation()}>
          {items.map((it) => (
            <button key={it.label} onClick={() => { it.onClick(); setOpen(false) }}
              className={`px-2 py-1.5 rounded-[6px] text-[13px] text-left hover:bg-bg-overlay transition-colors ${it.danger ? 'text-danger' : 'text-text-1'}`}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function QuickAdd({ onAdd }: { onAdd: (title: string) => Promise<void> }): JSX.Element {
  const [v, setV] = useState('')
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} placeholder="+ 添加卡片，回车确认"
      onKeyDown={(e) => { if (e.key === 'Enter' && v.trim() && !e.nativeEvent.isComposing) { void onAdd(v.trim()); setV('') } }}
      className="input !bg-transparent !border-transparent hover:!border-line focus:!bg-bg-raise text-[13px]" />
  )
}
