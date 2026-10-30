/**
 * 开放 API：桌面版（Tauri）在本机起 HTTP 服务（见 src-tauri/src/api_server.rs），
 * 外部工具（Raycast / 快捷指令 / 脚本）用 Bearer token 读写任务和笔记。
 * 本模块是前端侧：接 api-request 事件 → 路由 → 操作 Dexie → api_respond 回包。
 * 纯浏览器里没有宿主能监听端口，本功能仅 Tauri 下可用。
 */
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { db } from '../db/db'
import { saveSettings } from '../db/settings'
import { now, uid } from '../lib/id'
import { isTauri } from '../lib/tauri'
import { canParent, currentPeriod, inheritedScope, subtreeIds } from '../lib/okr'
import { levelOf } from '../lib/okrMove'
import type { AppSettings, Note, Todo, TodoStatus } from '../types'

export interface ApiRequest {
  req_id: number
  method: string
  path: string
  query: string
  body: string
}

type ApiResult = { status: number; body: unknown }

const STATUSES: TodoStatus[] = ['open', 'done', 'cancelled', 'pending_review']

function parseQuery(q: string): URLSearchParams {
  return new URLSearchParams(q)
}

function parseBody(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    return v as Record<string, unknown>
  } catch {
    return null
  }
}

/** 对外暴露的 Todo 形状：内部字段（sync_version 等）不外泄 */
function publicTodo(t: Todo): unknown {
  return {
    id: t.id, kind: t.kind, title: t.title, status: t.status,
    parent_id: t.parent_id, scope: t.scope, period: t.period,
    due_date: t.due_date, assignee: t.assignee, sort_order: t.sort_order,
    created_at: t.created_at, updated_at: t.updated_at,
  }
}

/**
 * 路由：method + path → Dexie 操作。返回 status + JSON 可序列化的 body。
 * 从 localApi 生命周期和测试里都会调用。
 */
export async function routeApiRequest(req: ApiRequest): Promise<ApiResult> {
  const segments = req.path.split('/').filter(Boolean)
  const q = parseQuery(req.query)

  // GET /todos?status=&kind=&parent_id=&q=
  if (req.method === 'GET' && segments.length === 1 && segments[0] === 'todos') {
    let rows = await db.todos.toArray()
    rows = rows.filter((t) => t.deleted_at === null)
    const status = q.get('status')
    if (status) {
      if (!STATUSES.includes(status as TodoStatus)) return { status: 400, body: { error: `status 需为 ${STATUSES.join('/')}` } }
      rows = rows.filter((t) => t.status === status)
    }
    if (q.get('kind')) rows = rows.filter((t) => t.kind === q.get('kind'))
    if (q.get('parent_id')) rows = rows.filter((t) => t.parent_id === q.get('parent_id'))
    const kw = (q.get('q') ?? '').trim().toLowerCase()
    if (kw) rows = rows.filter((t) => t.title.toLowerCase().includes(kw))
    return { status: 200, body: rows.sort((a, b) => a.sort_order - b.sort_order).map(publicTodo) }
  }

  // POST /todos {title, kind?, parent_id?, due_date?}
  if (req.method === 'POST' && segments.length === 1 && segments[0] === 'todos') {
    const body = parseBody(req.body)
    if (!body) return { status: 400, body: { error: 'body 需为 JSON 对象' } }
    const title = String(body.title ?? '').trim()
    if (!title) return { status: 400, body: { error: 'title 必填' } }
    const kind = (body.kind ?? 'task') as Todo['kind']
    if (!['objective', 'kr', 'task'].includes(kind)) return { status: 400, body: { error: 'kind 需为 objective/kr/task' } }
    const parentRow = body.parent_id ? await db.todos.get(String(body.parent_id)) : null
    if (body.parent_id && (!parentRow || parentRow.deleted_at !== null)) {
      return { status: 400, body: { error: 'parent_id 不存在' } }
    }
    const level = levelOf({ kind, scope: kind === 'task' ? null : (String(body.scope ?? 'strategic') as Todo['scope']) })
    if (!canParent(level, parentRow ?? null)) return { status: 400, body: { error: '不能挂到这个父节点下（层级规则）' } }
    const ts = now()
    const todo: Todo = {
      id: uid(),
      kind,
      parent_id: parentRow?.id ?? null,
      scope: inheritedScope(level, parentRow ?? null),
      period: level.scope === 'quarterly' && kind !== 'task' ? (parentRow?.period ?? String(body.period ?? currentPeriod())) : undefined,
      title,
      status: 'open',
      source: 'manual',
      due_date: typeof body.due_date === 'string' ? body.due_date : undefined,
      sort_order: Date.now(),
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
    }
    await db.todos.add(todo)
    return { status: 201, body: publicTodo(todo) }
  }

  // PATCH /todos/:id {title?, status?, due_date?, assignee?}
  if (req.method === 'PATCH' && segments.length === 2 && segments[0] === 'todos') {
    const body = parseBody(req.body)
    if (!body) return { status: 400, body: { error: 'body 需为 JSON 对象' } }
    const cur = await db.todos.get(segments[1])
    if (!cur || cur.deleted_at !== null) return { status: 404, body: { error: 'todo 不存在' } }
    const changes: Partial<Todo> = {}
    if (body.title !== undefined) {
      const title = String(body.title).trim()
      if (!title) return { status: 400, body: { error: 'title 不能为空' } }
      changes.title = title
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status as TodoStatus)) return { status: 400, body: { error: `status 需为 ${STATUSES.join('/')}` } }
      changes.status = body.status as TodoStatus
    }
    if (body.due_date !== undefined) changes.due_date = body.due_date ? String(body.due_date) : undefined
    if (body.assignee !== undefined) changes.assignee = String(body.assignee)
    if (Object.keys(changes).length === 0) return { status: 400, body: { error: '没有可更新的字段' } }
    await db.todos.update(cur.id, { ...changes, updated_at: now(), sync_version: cur.sync_version + 1 })
    return { status: 200, body: publicTodo(await db.todos.get(cur.id) as Todo) }
  }

  // DELETE /todos/:id —— 软删整棵子树（UI 里删除按钮的同款语义，含 tag 绑定）
  if (req.method === 'DELETE' && segments.length === 2 && segments[0] === 'todos') {
    const cur = await db.todos.get(segments[1])
    if (!cur || cur.deleted_at !== null) return { status: 404, body: { error: 'todo 不存在' } }
    const all = await db.todos.toArray()
    const ids = [...subtreeIds(cur.id, all)]
    const ts = now()
    await db.transaction('rw', db.todos, db.tagBindings, async () => {
      for (const id of ids) {
        await db.todos.update(id, { deleted_at: ts, updated_at: ts, status: 'cancelled' })
      }
      const bindings = await db.tagBindings
        .where('target_type').equals('todo')
        .and((b) => ids.includes(b.target_id) && b.deleted_at === null)
        .toArray()
      for (const b of bindings) {
        await db.tagBindings.update(b.id, { deleted_at: ts, updated_at: ts })
      }
    })
    return { status: 200, body: { ok: true, deleted: ids.length } }
  }

  // GET /notes?q=
  if (req.method === 'GET' && segments.length === 1 && segments[0] === 'notes') {
    let rows = await db.notes.toArray()
    rows = rows.filter((n) => n.deleted_at === null)
    const kw = (q.get('q') ?? '').trim().toLowerCase()
    if (kw) rows = rows.filter((n) => `${n.title}\n${n.body_md}`.toLowerCase().includes(kw))
    rows = rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    return { status: 200, body: rows.map((n) => ({ id: n.id, title: n.title, pinned: n.pinned, updated_at: n.updated_at })) }
  }

  // POST /notes {title?, body_md?}
  if (req.method === 'POST' && segments.length === 1 && segments[0] === 'notes') {
    const body = parseBody(req.body)
    if (!body) return { status: 400, body: { error: 'body 需为 JSON 对象' } }
    const ts = now()
    const note: Note = {
      id: uid(),
      title: String(body.title ?? '').trim(),
      body_md: String(body.body_md ?? ''),
      todo_ids: [],
      pinned: false,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
    }
    await db.notes.add(note)
    return { status: 201, body: { id: note.id, title: note.title, body_md: note.body_md, created_at: note.created_at } }
  }

  // GET /notes/:id
  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'notes') {
    const note = await db.notes.get(segments[1])
    if (!note || note.deleted_at !== null) return { status: 404, body: { error: '笔记不存在' } }
    return { status: 200, body: { id: note.id, title: note.title, body_md: note.body_md, todo_ids: note.todo_ids, pinned: note.pinned, created_at: note.created_at, updated_at: note.updated_at } }
  }

  return { status: 404, body: { error: `未知路由：${req.method} ${req.path}` } }
}

function newToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 启动时调用：按 settings 决定是否起服务；token 为空则自动生成一个 */
export async function initLocalApi(settings: AppSettings): Promise<void> {
  if (!isTauri()) return
  let token = settings.api_token
  if (settings.api_enabled && !token) {
    token = newToken()
    await saveSettings({ api_token: token })
  }
  await listen<ApiRequest>('api-request', (ev) => {
    void (async () => {
      const req = ev.payload
      let result: ApiResult
      try {
        result = await routeApiRequest(req)
      } catch (e) {
        result = { status: 500, body: { error: e instanceof Error ? e.message : String(e) } }
      }
      await invoke('api_respond', { reqId: req.req_id, status: result.status, body: JSON.stringify(result.body) })
    })()
  })
  if (settings.api_enabled) {
    await invoke('api_server_start', { port: settings.api_port, token }).catch((e) => {
      console.error('开放 API 启动失败', e)
    })
  }
}

/** 设置页开关调用：立即启停 */
export async function setApiEnabled(enabled: boolean, port: number, token: string): Promise<void> {
  if (!isTauri()) return
  if (enabled) {
    await invoke('api_server_start', { port, token })
  } else {
    await invoke('api_server_stop')
  }
}
