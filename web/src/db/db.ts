import Dexie, { type Table } from 'dexie'
import type {
  AudioChunk, BlockComment, Board, ChatMessage, KnowledgeEntry, Meeting, Note, Notebook, PinnedAssistCard, QueueJob, Scribble,
  Summary, SummaryTemplate, Tag, TagBinding, Todo, Transcript,
} from '../types'

export class ShibeiDB extends Dexie {
  meetings!: Table<Meeting, string>
  audioChunks!: Table<AudioChunk, string>
  transcripts!: Table<Transcript, string>
  notes!: Table<Note, string>
  summaries!: Table<Summary, string>
  templates!: Table<SummaryTemplate, string>
  todos!: Table<Todo, string>
  tags!: Table<Tag, string>
  tagBindings!: Table<TagBinding, string>
  chatMessages!: Table<ChatMessage, string>
  queueJobs!: Table<QueueJob, string>
  kv!: Table<{ key: string; value: unknown }, string>
  // Phase-2 item 5: 知识库索引（关键词/标题检索，MVP）
  knowledgeEntries!: Table<KnowledgeEntry, string>
  // Phase-2 item 5: 会议下 pinned assist 卡片（meeting-scoped）
  pinnedAssistCards!: Table<PinnedAssistCard, string>
  // Phase-4: 会中速记 bullet（时间轴对齐），Polish 读它拼成笔记骨架
  scribbles!: Table<Scribble, string>
  comments!: Table<BlockComment, string>
  notebooks!: Table<Notebook, string>
  boards!: Table<Board, string>
  /** 同步发件箱：本地变更排队，等下次 syncNow 推给 relay */
  syncOutbox!: Table<SyncOutboxRow, number>

  constructor() {
    super('shibei')
    this.version(1).stores({
      meetings: 'id, status, started_at, note_id',
      audioChunks: 'id, meeting_id, [meeting_id+seq]',
      transcripts: 'id, meeting_id',
      notes: 'id, meeting_id, updated_at',
      summaries: 'id, meeting_id, template_id',
      templates: 'id, is_default',
      todos: 'id, parent_id, kind, status, due_date, meeting_id, origin_note_id',
      tags: 'id, name',
      tagBindings: 'id, tag_id, [target_type+target_id]',
      chatMessages: 'id, meeting_id',
      queueJobs: 'id, status, type',
      kv: 'key',
    })
    // v2: 增补 todos.origin_note_id 索引（修复 NoteDetailPage Dexie SchemaError）
    this.version(2).stores({
      todos: 'id, parent_id, kind, status, due_date, meeting_id, origin_note_id, source',
      meetings: 'id, status, started_at, note_id, calendar_event_id',
    })
    // v3: 嵌套 OKR —— 旧 objective/kr 映射为 strategic；挂在 KR 下的 task 继承 strategic，自由 task 为 null（Inbox）
    this.version(3).stores({
      todos: 'id, parent_id, kind, status, due_date, meeting_id, origin_note_id, source, scope, period',
    }).upgrade((tx) =>
      tx.table('todos').toCollection().modify((t: Todo) => {
        if (t.scope !== undefined) return
        t.scope = t.kind === 'task' && t.parent_id === null ? null : 'strategic'
      }),
    )
    // v4: Phase-2 知识库 + 会议 pinned assist
    this.version(4).stores({
      knowledgeEntries: 'id, folder, mtime',
      pinnedAssistCards: 'id, meeting_id, [meeting_id+created_at]',
    })
    // v5: Phase-4 速记 bullet（会中键入即存，带时间轴）
    this.version(5).stores({
      scribbles: 'id, meeting_id, [meeting_id+created_at]',
    })
    // v6: 页面树 —— Note.parent_id（会议纪要不进树，无需索引会议归属变化）
    this.version(6).stores({
      notes: 'id, meeting_id, updated_at, parent_id',
    })
    // v7: 块评论
    this.version(7).stores({
      comments: 'id, note_id, [note_id+created_at]',
    })
    // v8: 多笔记本（Note.notebook_id）+ 多看板（Todo.board_id，board_col 变自由列名）
    this.version(8).stores({
      notebooks: 'id, sort_order',
      boards: 'id, sort_order',
      notes: 'id, meeting_id, updated_at, parent_id, notebook_id',
      todos: 'id, parent_id, kind, status, due_date, meeting_id, origin_note_id, source, scope, period, board_id',
    })
    // v9: 同步发件箱（本地变更 → relay）
    this.version(9).stores({
      syncOutbox: '++id, [entity+entity_id], entity, created_at',
    })
    // v10: 脑图任务 —— Todo.map_id 索引 + 存量 backfill
    this.version(10)
      .stores({
        todos:
          'id,parent_id,kind,status,due_date,meeting_id,origin_note_id,source,scope,period,board_id,map_id',
      })
      .upgrade(async (tx) => {
        const table = tx.table('todos')
        const rows = await table.toArray()
        const byId = new Map(rows.map((r: { id: string }) => [r.id, r]))

        const findRoot = (startId: string): string => {
          let cur: string | null = startId
          const seen = new Set<string>()
          while (cur && !seen.has(cur)) {
            seen.add(cur)
            const row = byId.get(cur) as { id: string; parent_id: string | null } | undefined
            if (!row || row.parent_id == null) return row?.id ?? startId
            if (!byId.has(row.parent_id)) return row.id // 孤儿：自封为根
            cur = row.parent_id
          }
          return startId
        }

        for (const r of rows as Array<{ id: string; parent_id: string | null; map_id?: string }>) {
          if (r.map_id) continue
          const root = r.parent_id == null ? r.id : findRoot(r.id)
          await table.update(r.id, { map_id: root })
        }
        // 纠偏：根上 map_id 必须 === id
        for (const r of rows as Array<{ id: string; parent_id: string | null }>) {
          if (r.parent_id == null) await table.update(r.id, { map_id: r.id })
        }
      })
  }
}

/** 发件箱一行：某个实体的最新待推送状态 */
export interface SyncOutboxRow {
  id?: number
  entity: string
  entity_id: string
  op: 'upsert' | 'delete'
  /** 实体快照 JSON */
  data: Record<string, unknown> | null
  updated_at: string
  sync_version: number
  created_at: string
}

export const db = new ShibeiDB()
