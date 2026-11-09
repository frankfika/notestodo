import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useUI } from '../../state/ui'
import {
  applyTodoPatches,
  mindEventToTodoPatches,
  todosToMindData,
} from '../../lib/mindmap/convert'
import { tryAddTodaySlot } from '../../lib/mindmap/todayBridge'
import { pushTodoStatusUndo, setMindmapEditing } from '../../lib/mindmap/undoStack'
import { indexByParent, isLeafTodo, todayEligible } from '../../lib/mindmap/leaf'
import type { MeOperation } from '../../lib/mindmap/types'
import type { ID } from '../../types'
import { now } from '../../lib/id'
import MindmapCoachBar, { type CoachHint } from './MindmapCoachBar'
import './mindmap.css'

export type MindmapCanvasProps = {
  rootId: ID
}

type MindElixirInstance = {
  init: (data: unknown) => void | Promise<void>
  refresh?: (data: unknown) => void
  destroy?: () => void
  bus: { addListener: (ev: string, fn: (payload: MeOperation) => void) => void }
  findEle?: (id: string) => unknown
  selectNode?: (el: unknown, center?: boolean) => void
  currentNode?: { nodeObj?: { id: string } }
}

export default function MindmapCanvas({ rootId }: MindmapCanvasProps): JSX.Element {
  const elRef = useRef<HTMLDivElement>(null)
  const meiRef = useRef<MindElixirInstance | null>(null)
  const editingRef = useRef(false)
  const todos = useLiveQuery(() => db.todos.toArray(), []) ?? []
  const focusId = useUI((s) => s.todoFocusId)
  const goTodos = useUI((s) => s.goTodos)
  const [selectedId, setSelectedId] = useState<ID | null>(null)
  const [coachHint, setCoachHint] = useState<CoachHint>(null)

  const selected = useMemo(
    () => (selectedId ? todos.find((t) => t.id === selectedId) ?? null : null),
    [selectedId, todos],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const MindElixir = (await import('mind-elixir')).default
      await import('mind-elixir/style.css')
      if (cancelled || !elRef.current) return
      const mei = new MindElixir({
        el: elRef.current,
        direction: 1,
        editable: true,
        toolBar: false,
        contextMenu: false,
        allowUndo: false,
        newTopicName: '',
      }) as MindElixirInstance
      const data = todosToMindData(todos, rootId)
      await mei.init(data)
      mei.bus.addListener('operation', (ev: MeOperation) => {
        if ((ev as { name?: string }).name === 'beginEdit') {
          editingRef.current = true
          setMindmapEditing(true)
          return
        }
        if (ev.name === 'finishEdit') {
          editingRef.current = false
          setMindmapEditing(false)
        }
        const byId = new Map(todos.map((t) => [t.id, t]))
        const ops = mindEventToTodoPatches(ev, { all: todos, mapId: rootId, byId })
        void applyTodoPatches(ops)
      })
      meiRef.current = mei
    })()
    return () => {
      cancelled = true
      meiRef.current?.destroy?.()
      meiRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId])

  useEffect(() => {
    const mei = meiRef.current
    if (!mei || editingRef.current) return
    const data = todosToMindData(todos, rootId)
    if (typeof mei.refresh === 'function') mei.refresh(data)
    else {
      const hash = todos
        .map(
          (t) =>
            `${t.id}:${t.parent_id}:${t.title}:${t.status}:${t.sort_order}:${t.waiting_reason ?? ''}`,
        )
        .join('|')
      const prev = mei as MindElixirInstance & { __hash?: string }
      if (prev.__hash === hash) return
      prev.__hash = hash
      void mei.init(data)
    }
  }, [todos, rootId])

  useEffect(() => {
    if (!focusId || !meiRef.current) return
    const el = meiRef.current.findEle?.(focusId)
    if (el) meiRef.current.selectNode?.(el, true)
    setSelectedId(focusId)
    useUI.setState({ todoFocusId: null })
  }, [focusId])

  useEffect(() => {
    const host = elRef.current
    if (!host) return
    const onPick = (): void => {
      const id = meiRef.current?.currentNode?.nodeObj?.id
      if (id && !id.startsWith('done-group:')) setSelectedId(id)
      else setSelectedId(null)
      setCoachHint(null)
    }
    host.addEventListener('click', onPick)
    return () => host.removeEventListener('click', onPick)
  }, [rootId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingRef.current) return
      const mei = meiRef.current
      const node = mei?.currentNode?.nodeObj
      if (!node || node.id.startsWith('done-group:')) return
      const byParent = indexByParent(todos)
      const t = todos.find((x) => x.id === node.id)
      if (!t) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (!isLeafTodo(t, byParent)) return
        const prev = t.status
        pushTodoStatusUndo(t.id, prev)
        void db.todos.update(t.id, {
          status: t.status === 'done' ? 'open' : 'done',
          updated_at: now(),
          sync_version: t.sync_version + 1,
        })
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
        e.preventDefault()
        if (todayEligible(t, byParent)) {
          void tryAddTodaySlot(t.id, rootId)
        } else if (!isLeafTodo(t, byParent)) {
          setSelectedId(t.id)
          setCoachHint('split-for-today')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [todos, rootId])

  return (
    <div className="flex flex-col h-full min-h-0 w-full">
      <div ref={elRef} className="mindmap-canvas flex-1 min-h-0 w-full" />
      <MindmapCoachBar
        selected={selected}
        all={todos}
        coachHint={coachHint}
        onClearHint={() => setCoachHint(null)}
        onFocusTodo={(id) => goTodos(id)}
      />
    </div>
  )
}
