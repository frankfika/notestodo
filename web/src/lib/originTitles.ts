import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import { db } from '../db/db'
import type { Meeting, Note, Todo } from '../types'

export interface OriginTitles {
  /** 笔记 id → 标题（无标题笔记给「无标题」） */
  noteTitles: Map<string, string>
  /** 会议 id → 标题 */
  meetingTitles: Map<string, string>
}

/**
 * 任务来源（笔记 / 会议）标题：整页一条订阅，只读被真正引用到的那几条。
 *
 * 原来每个任务行各挂两条表级 liveQuery（db.notes.get / db.meetings.get），
 * 任意一条笔记被改 → 所有来源行重查 + 拿到新对象 → 整行重渲染（内容其实没变）。
 * 现在订阅在页面级一次拿，标题没变时 Map 身份也不变 → 行不会白刷。
 */
export function useOriginTitles(todos: Todo[]): OriginTitles {
  const { noteIds, meetingIds, noteKey, meetingKey } = useMemo(() => {
    const ns = new Set<string>()
    const ms = new Set<string>()
    for (const t of todos) {
      if (t.origin_note_id) ns.add(t.origin_note_id)
      if (t.meeting_id) ms.add(t.meeting_id)
    }
    const n = [...ns]
    const m = [...ms]
    return { noteIds: n, meetingIds: m, noteKey: n.join(','), meetingKey: m.join(',') }
  }, [todos])

  const notes = useLiveQuery(async () => {
    if (!noteIds.length) return []
    return (await db.notes.bulkGet(noteIds)).filter((n): n is Note => !!n)
  }, [noteKey])

  const meetings = useLiveQuery(async () => {
    if (!meetingIds.length) return []
    return (await db.meetings.bulkGet(meetingIds)).filter((m): m is Meeting => !!m)
  }, [meetingKey])

  // 查询结果每次写库都是新数组/新对象 —— 用内容 key 兜住，只有标题真变了才换 Map 身份
  const noteTitleKey = (notes ?? []).map((n) => `${n.id}\u0000${n.title}`).join('\u0001')
  const meetingTitleKey = (meetings ?? []).map((m) => `${m.id}\u0000${m.title}`).join('\u0001')

  const noteTitles = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of notes ?? []) m.set(n.id, n.title || '无标题')
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteTitleKey])

  const meetingTitles = useMemo(() => {
    const m = new Map<string, string>()
    for (const x of meetings ?? []) m.set(x.id, x.title)
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingTitleKey])

  return { noteTitles, meetingTitles }
}
