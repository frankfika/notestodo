import type { ID, Todo } from '../../types'
import { ensureInboxMap } from './mapRoots'
import { indexByParent, isLeafTodo, isLive } from './leaf'

/** Inbox 图根（幂等创建） */
export async function getInboxMapId(): Promise<ID> {
  const inbox = await ensureInboxMap()
  return inbox.id
}

/** Inbox 下待整理的开放叶子（捕获区） */
export function listInboxCaptureLeaves(all: Todo[], inboxId: ID): Todo[] {
  const byParent = indexByParent(all)
  return (byParent.get(inboxId) ?? [])
    .filter((t) => isLive(t) && t.status === 'open' && isLeafTodo(t, byParent))
    .sort((a, b) => b.sort_order - a.sort_order)
}
