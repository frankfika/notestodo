import type { Todo } from '../types'

export function formatDueLabel(dueDate?: string, dueTime?: string): string {
  if (!dueDate) return ''
  const [, m, d] = dueDate.split('-')
  const base = `${Number(m)}/${Number(d)}`
  return dueTime ? `${base} ${dueTime}` : base
}

export function hasDueMeta(t: Pick<Todo, 'due_date' | 'due_time'>): boolean {
  return Boolean(t.due_date)
}
