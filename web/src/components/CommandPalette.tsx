import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useUI } from '../state/ui'
import { useRecorder } from '../state/recorder'
import { db } from '../db/db'
import { mod } from '../lib/id'

interface Item {
  group: '动作' | '跳转' | '笔记' | '任务' | '会议'
  label: string
  hint?: string
  run: () => void | Promise<void>
}

export default function CommandPalette() {
  const open = useUI((s) => s.cmdkOpen)
  const setOpen = useUI((s) => s.setCmdkOpen)
  const start = useRecorder((s) => s.start)
  const stop = useRecorder((s) => s.stop)
  const phase = useRecorder((s) => s.phase)

  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const needle = q.trim().toLowerCase()

  // 内容搜索：只有输入了关键字才查库（⌘K 空态保持纯导航）
  const hits = useLiveQuery(async () => {
    if (!needle) return { notes: [], todos: [], meetings: [] }
    const [notes, todos, meetings] = await Promise.all([
      db.notes.filter((n) => n.deleted_at === null && (n.title || '').toLowerCase().includes(needle)).limit(6).toArray(),
      db.todos.filter((t) => t.deleted_at === null && t.title.toLowerCase().includes(needle)).limit(6).toArray(),
      db.meetings.filter((m) => m.deleted_at === null && m.title.toLowerCase().includes(needle)).limit(4).toArray(),
    ])
    return { notes, todos, meetings }
  }, [needle])

  useEffect(() => {
    if (open) {
      setQ('')
      setCursor(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const items: Item[] = useMemo(() => {
    const go = useUI.getState()
    const recHint = `${mod()}⇧R`
    const recAction: Item =
      phase === 'recording'
        ? { group: '动作', label: '停止录音', hint: recHint, run: () => stop() }
        : { group: '动作', label: '开始录音', hint: recHint, run: () => start() }
    return [
      recAction,
      { group: '动作', label: '导出全部数据', run: () => void go.goSettings() },
      { group: '跳转', label: '会议', hint: '1', run: () => go.goMeetings() },
      { group: '跳转', label: '笔记', hint: '2', run: () => go.goNotes() },
      { group: '跳转', label: '待办', hint: '3', run: () => go.goTodos() },
      { group: '跳转', label: '看板', run: () => go.goBoard() },
      { group: '跳转', label: '周报', run: () => go.goReport() },
      { group: '跳转', label: '模板', hint: '4', run: () => go.goTemplates() },
      { group: '跳转', label: '设置', run: () => go.goSettings() },
    ]
  }, [phase, start, stop])

  const filtered = useMemo(() => {
    const contentItems: Item[] = []
    if (hits) {
      const go = useUI.getState()
      for (const n of hits.notes) contentItems.push({ group: '笔记', label: n.title || '无标题', run: () => go.goNote(n.id) })
      for (const t of hits.todos) contentItems.push({ group: '任务', label: t.title, run: () => go.goTodos(t.id) })
      for (const m of hits.meetings) contentItems.push({ group: '会议', label: m.title, run: () => go.goMeeting(m.id) })
    }
    if (!needle) return items
    const nav = items.filter((i) => i.label.toLowerCase().includes(needle) || i.group.includes(needle))
    return [...contentItems, ...nav]
  }, [items, needle, hits])

  // 按 1-5 数字键跳转
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); return }
      if (e.key === 'Enter') { filtered[cursor]?.run(); setOpen(false); return }
      if (e.key === 'ArrowDown') { setCursor((c) => Math.min(c + 1, filtered.length - 1)); return }
      if (e.key === 'ArrowUp') { setCursor((c) => Math.max(0, c - 1)); return }
      if (/^[1-4]$/.test(e.key) && !q) {
        const map: Record<string, () => void> = {
          '1': useUI.getState().goMeetings,
          '2': useUI.getState().goNotes,
          '3': useUI.getState().goTodos,
          '4': useUI.getState().goTemplates,
        }
        map[e.key]?.(); setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, filtered, cursor, setOpen])

  if (!open) return null

  // 按组分组
  const groups: { name: Item['group']; list: Item[] }[] = []
  for (const item of filtered) {
    const g = groups.find((x) => x.name === item.group)
    if (g) g.list.push(item)
    else groups.push({ name: item.group, list: [item] })
  }

  let idx = -1

  return (
    <div
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-scrim backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[560px] max-w-[92vw] rounded-2xl border border-line-strong bg-bg-raise shadow-2xl overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-line">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setCursor(0) }}
            placeholder="输入以搜索 · 1-4 跳转 · Esc 关闭"
            className="w-full bg-transparent text-[15px] text-text-1 placeholder:text-text-3 outline-none"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-10 text-center text-text-3 text-sm">没有匹配项</div>
          )}
          {groups.map((g) => (
            <div key={g.name} className="py-1">
              <div className="px-4 pt-2 pb-1 text-[11px] font-semibold text-text-3 tracking-widest">{g.name}</div>
              {g.list.map((item) => {
                idx++
                const active = idx === cursor
                return (
                  <button
                    key={item.label}
                    onClick={() => { void item.run(); setOpen(false) }}
                    onMouseEnter={() => setCursor(idx)}
                    className={`w-full flex items-center px-4 py-2 text-sm transition-colors ${
                      active ? 'bg-accent/15 text-text-1' : 'text-text-2 hover:bg-bg-overlay'
                    }`}
                  >
                    <span className="flex-1 text-left">{item.label}</span>
                    {item.hint && <span className="kbd">{item.hint}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}