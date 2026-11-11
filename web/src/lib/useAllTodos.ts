import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import type { Todo } from '../types'

/**
 * 全量 todos 的共享响应式订阅。
 *
 * 之前 `useLiveQuery(() => db.todos.toArray(), [])` 散在近十处各自订阅，
 * 任何任务变更全部重跑。统一从这里拿，语义只有一份；
 * 后续要加浅比较 / 分片缓存也只动这一个文件。
 */
export function useAllTodos(): Todo[] {
  return useLiveQuery(() => db.todos.toArray(), []) ?? []
}
