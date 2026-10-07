import Dexie, { type Table } from 'dexie'
import type {
  AudioChunk, ChatMessage, Meeting, Note, QueueJob, Summary,
  SummaryTemplate, Tag, TagBinding, Todo, Transcript,
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

  constructor() {
    super('shibei')
    this.version(1).stores({
      meetings: 'id, status, started_at, note_id',
      audioChunks: 'id, meeting_id, [meeting_id+seq]',
      transcripts: 'id, meeting_id',
      notes: 'id, meeting_id, updated_at',
      summaries: 'id, meeting_id, template_id',
      templates: 'id, is_default',
      todos: 'id, parent_id, kind, status, due_date, meeting_id',
      tags: 'id, name',
      tagBindings: 'id, tag_id, [target_type+target_id]',
      chatMessages: 'id, meeting_id',
      queueJobs: 'id, status, type',
      kv: 'key',
    })
  }
}

export const db = new ShibeiDB()
