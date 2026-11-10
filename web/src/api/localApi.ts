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
import { isMindmapTasksEnabled } from '../lib/features'
import { isDescendant } from '../lib/mindmap/cycle'
import { indexByParent, isLeafTodo } from '../lib/mindmap/leaf'
import { archiveMap, listMapRootsFiltered, publicMapRoot, restoreMap } from '../lib/mindmap/mapArchive'
import { captureToInbox, listInboxCaptures } from '../lib/mindmap/inboxCapture'
import { ensureInboxMap } from '../lib/mindmap/mapRoots'
import {
  addSlot,
  evictIfPresent,
  getToday,
  removeSlot,
  setToday,
  slotsPublicOnly,
  swapSlot,
  todayStatePublic,
} from '../lib/mindmap/todaySlots'
import type { TodayState } from '../lib/mindmap/types'
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

type PublicTodoOpts = {
  byParent?: Map<string | null, Todo[]>
  todayLeafIds?: Set<string>
  enrich?: boolean
}

/** 对外暴露的 Todo 形状：内部字段（sync_version 等）不外泄 */
function publicTodo(t: Todo, opts?: PublicTodoOpts): unknown {
  const base: Record<string, unknown> = {
    id: t.id,
    kind: t.kind,
    title: t.title,
    status: t.status,
    parent_id: t.parent_id,
    scope: t.scope,
    period: t.period,
    due_date: t.due_date,
    assignee: t.assignee,
    sort_order: t.sort_order,
    created_at: t.created_at,
    updated_at: t.updated_at,
    map_id: t.map_id ?? null,
    waiting_reason: t.waiting_reason ?? null,
  }
  if (opts?.enrich && opts.byParent) {
    base.is_leaf = isLeafTodo(t, opts.byParent)
    base.in_today = opts.todayLeafIds?.has(t.id) ?? false
  }
  return base
}

function parseTodayBody(body: Record<string, unknown>): TodayState | null {
  const cap = body.capacity
  const slotsRaw = body.slots
  if (cap !== undefined && (typeof cap !== 'number' || Number.isNaN(cap))) return null
  if (slotsRaw !== undefined && !Array.isArray(slotsRaw)) return null
  const slots = (slotsRaw ?? []) as unknown[]
  const parsed = slots.map((s) => {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return null
    const o = s as Record<string, unknown>
    const leafId = o.leaf_id ?? o.leafId
    const mapId = o.map_id ?? o.mapId
    const slottedAt = o.slotted_at ?? o.slottedAt
    if (typeof leafId !== 'string' || typeof mapId !== 'string') return null
    return {
      leafId,
      mapId,
      slottedAt: typeof slottedAt === 'string' ? slottedAt : now(),
    }
  })
  if (parsed.some((x) => x === null)) return null
  return {
    capacity: typeof cap === 'number' ? cap : 5,
    slots: parsed as TodayState['slots'],
  }
}

/**
 * 路由：method + path → Dexie 操作。返回 status + JSON 可序列化的 body。
 * 从 localApi 生命周期和测试里都会调用。
 */
export async function routeApiRequest(req: ApiRequest): Promise<ApiResult> {
  const segments = req.path.split('/').filter(Boolean)
  const q = parseQuery(req.query)

  const mindmap = await isMindmapTasksEnabled()
  const todayState = mindmap ? await getToday() : null
  const todayLeafIds = new Set(todayState?.slots.map((s) => s.leafId) ?? [])

  async function todoPublicContext(): Promise<PublicTodoOpts> {
    if (!mindmap) return {}
    const all = await db.todos.toArray()
    return {
      enrich: true,
      byParent: indexByParent(all),
      todayLeafIds,
    }
  }

  // GET /maps?archived=0|1
  if (req.method === 'GET' && segments.length === 1 && segments[0] === 'maps') {
    if (!mindmap) return { status: 404, body: { error: 'mindmap_tasks 未开启' } }
    const archived = q.get('archived') === '1' || q.get('archived') === 'true'
    const rows = await listMapRootsFiltered({ archived })
    return { status: 200, body: rows.map(publicMapRoot) }
  }

  // POST /maps/:id/archive
  if (req.method === 'POST' && segments.length === 3 && segments[0] === 'maps' && segments[2] === 'archive') {
    if (!mindmap) return { status: 404, body: { error: 'mindmap_tasks 未开启' } }
    const result = await archiveMap(segments[1])
    if (result.ok) {
      const root = (await db.todos.get(segments[1])) as Todo
      return { status: 200, body: publicMapRoot(root) }
    }
    const code =
      result.reason === 'not_found' ? 404
        : result.reason === 'inbox' || result.reason === 'open_leaves' || result.reason === 'already' ? 409
          : 400
    const msg =
      result.reason === 'inbox' ? 'Inbox 不可归档'
        : result.reason === 'open_leaves' ? '仍有开放叶子，无法归档'
          : result.reason === 'already' ? '已是归档状态'
            : '图不存在'
    return { status: code, body: { error: result.reason, message: msg } }
  }

  // POST /maps/:id/restore
  if (req.method === 'POST' && segments.length === 3 && segments[0] === 'maps' && segments[2] === 'restore') {
    if (!mindmap) return { status: 404, body: { error: 'mindmap_tasks 未开启' } }
    const result = await restoreMap(segments[1])
    if (result.ok) {
      const root = (await db.todos.get(segments[1])) as Todo
      return { status: 200, body: publicMapRoot(root) }
    }
    return {
      status: result.reason === 'not_found' ? 404 : 409,
      body: { error: result.reason, message: result.reason === 'not_archived' ? '未归档' : '图不存在' },
    }
  }

  // GET /inbox/captures
  if (req.method === 'GET' && segments.length === 2 && segments[0] === 'inbox' && segments[1] === 'captures') {
    if (!mindmap) return { status: 404, body: { error: 'mindmap_tasks 未开启' } }
    const rows = await listInboxCaptures()
    const ctx = await todoPublicContext()
    return { status: 200, body: rows.map((t) => publicTodo(t, ctx)) }
  }

  // POST /inbox/captures { title }
  if (req.method === 'POST' && segments.length === 2 && segments[0] === 'inbox' && segments[1] === 'captures') {
    if (!mindmap) return { status: 404, body: { error: 'mindmap_tasks 未开启' } }
    const body = parseBody(req.body)
    if (!body) return { status: 400, body: { error: 'body 需为 JSON 对象' } }
    const title = String(body.title ?? '').trim()
    if (!title) return { status: 400, body: { error: 'title 必填' } }
    const todo = await captureToInbox(title)
    const ctx = await todoPublicContext()
    return { status: 201, body: publicTodo(todo, ctx) }
  }

  // GET /today
  if (req.method === 'GET' && segments.length === 1 && segments[0] === 'today') {
    if (!mindmap) return { status: 404, body: { error: 'mindmap_tasks 未开启' } }
    const state = await getToday()
    const todos = await db.todos.toArray()
    return { status: 200, body: todayStatePublic(state, todos) }
  }

  // PUT /today — 整写 capacity + slots
  if (req.method === 'PUT' && segments.length === 1 && segments[0] === 'today') {
    if (!mindmap) return { status: 404, body: { error: 'mindmap_tasks 未开启' } }
    const body = parseBody(req.body)
    if (!body) return { status: 400, body: { error: 'body 需为 JSON 对象' } }
    const parsed = parseTodayBody(body)
    if (!parsed) return { status: 400, body: { error: 'today body 格式无效' } }
    await setToday(parsed)
    const state = await getToday()
    const todos = await db.todos.toArray()
    return { status: 200, body: todayStatePublic(state, todos) }
  }

  // POST /today/slots — add 或 swap
  if (req.method === 'POST' && segments.length === 2 && segments[0] === 'today' && segments[1] === 'slots') {
    if (!mindmap) return { status: 404, body: { error: 'mindmap_tasks 未开启' } }
    const body = parseBody(req.body)
    if (!body) return { status: 400, body: { error: 'body 需为 JSON 对象' } }
    const leafId = String(body.leaf_id ?? body.leafId ?? '')
    const mapId = String(body.map_id ?? body.mapId ?? '')
    if (!leafId) return { status: 400, body: { error: 'leaf_id 必填' } }
    if (!mapId) return { status: 400, body: { error: 'map_id 必填' } }
    const swapOut = body.swap_out_id ?? body.swapOutId
    const result = swapOut
      ? await swapSlot(leafId, mapId, String(swapOut))
      : await addSlot(leafId, mapId)
    const pub = {
      capacity: result.state.capacity,
      slots: slotsPublicOnly(result.state),
    }
    if (result.ok) return { status: 200, body: pub }
    if (result.reason === 'full') {
      return {
        status: 409,
        body: {
          error: 'full',
          capacity: result.state.capacity,
          slots: slotsPublicOnly(result.state),
          hint: 'retry with swap_out_id',
        },
      }
    }
    if (result.reason === 'duplicate') {
      return { status: 409, body: { error: 'duplicate', leaf_id: leafId } }
    }
    return { status: 400, body: { error: 'not_eligible', leaf_id: leafId } }
  }

  // DELETE /today/slots/:leafId
  if (req.method === 'DELETE' && segments.length === 3 && segments[0] === 'today' && segments[1] === 'slots') {
    if (!mindmap) return { status: 404, body: { error: 'mindmap_tasks 未开启' } }
    const state = await removeSlot(segments[2])
    return { status: 200, body: { capacity: state.capacity, slots: slotsPublicOnly(state) } }
  }

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
    const ctx = await todoPublicContext()
    return { status: 200, body: rows.sort((a, b) => a.sort_order - b.sort_order).map((t) => publicTodo(t, ctx)) }
  }

  // POST /todos {title, kind?, parent_id?, due_date?}
  if (req.method === 'POST' && segments.length === 1 && segments[0] === 'todos') {
    const body = parseBody(req.body)
    if (!body) return { status: 400, body: { error: 'body 需为 JSON 对象' } }
    const title = String(body.title ?? '').trim()
    if (!title) return { status: 400, body: { error: 'title 必填' } }
    const kind = (body.kind ?? 'task') as Todo['kind']
    if (!['objective', 'kr', 'task'].includes(kind)) return { status: 400, body: { error: 'kind 需为 objective/kr/task' } }
    let parentId: string | null = body.parent_id ? String(body.parent_id) : null
    let mapId: string | undefined
    if (mindmap && kind === 'task' && !body.parent_id) {
      const inbox = await ensureInboxMap()
      parentId = inbox.id
      mapId = inbox.id
    }
    const parentRow = parentId ? await db.todos.get(parentId) : null
    if (parentId && (!parentRow || parentRow.deleted_at !== null)) {
      return { status: 400, body: { error: 'parent_id 不存在' } }
    }
    const level = levelOf({ kind, scope: kind === 'task' ? null : (String(body.scope ?? 'strategic') as Todo['scope']) })
    if (!canParent(level, parentRow ?? null)) return { status: 400, body: { error: '不能挂到这个父节点下（层级规则）' } }
    const ts = now()
    const resolvedMapId = mapId ?? parentRow?.map_id ?? (parentId === null ? undefined : parentId ?? undefined)
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
      map_id: resolvedMapId,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
      sync_version: 0,
    }
    if (todo.parent_id === null && todo.map_id === undefined) {
      todo.map_id = todo.id
    }
    await db.todos.add(todo)
    const ctx = await todoPublicContext()
    return { status: 201, body: publicTodo(todo, ctx) }
  }

  // PATCH /todos/:id {title?, status?, due_date?, assignee?, completed?, waiting_reason?, parent_id?, map_id?}
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
    if (body.completed !== undefined) {
      changes.status = body.completed ? 'done' : 'open'
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status as TodoStatus)) return { status: 400, body: { error: `status 需为 ${STATUSES.join('/')}` } }
      changes.status = body.status as TodoStatus
    }
    // 状态变了就把完成日期一起记上（外部 API 也要跟 UI 口径一致）
    if (changes.status && changes.status !== cur.status) {
      changes.completed_at = changes.status === 'done' ? new Date().toISOString() : null
      if (changes.status === 'cancelled') changes.archived_at = new Date().toISOString()
    }
    // 归档 / 取消归档
    if (body.archived !== undefined) {
      const ts = new Date().toISOString()
      if (body.archived) {
        changes.status = 'cancelled'
        changes.archived_at = ts
        changes.completed_at = cur.completed_at ?? ts
      } else {
        changes.status = cur.completed_at ? 'done' : 'open'
        changes.archived_at = null
      }
    }
    if (body.due_date !== undefined) changes.due_date = body.due_date ? String(body.due_date) : undefined
    if (body.assignee !== undefined) changes.assignee = String(body.assignee)
    if (body.waiting_reason !== undefined) {
      const wr = body.waiting_reason === null || body.waiting_reason === '' ? undefined : String(body.waiting_reason)
      changes.waiting_reason = wr
    }
    if (body.map_id !== undefined) changes.map_id = String(body.map_id)
    if (body.parent_id !== undefined) {
      const parent_id = body.parent_id === null ? null : String(body.parent_id)
      if (parent_id === cur.id) {
        return { status: 400, body: { error: 'cycle', message: 'parent_id would create a cycle' } }
      }
      const all = await db.todos.toArray()
      const byId = new Map(all.map((t) => [t.id, t]))
      if (parent_id && isDescendant(cur.id, parent_id, byId)) {
        return { status: 400, body: { error: 'cycle', message: 'parent_id would create a cycle' } }
      }
      if (parent_id) {
        const p = await db.todos.get(parent_id)
        if (!p || p.deleted_at !== null) return { status: 400, body: { error: 'parent_id 不存在' } }
      }
      changes.parent_id = parent_id
    }
    if (Object.keys(changes).length === 0) return { status: 400, body: { error: '没有可更新的字段' } }
    await db.todos.update(cur.id, { ...changes, updated_at: now(), sync_version: cur.sync_version + 1 })
    const updated = (await db.todos.get(cur.id)) as Todo
    if (mindmap) {
      if (changes.status === 'done' || body.completed === true) await evictIfPresent(cur.id)
      if (changes.waiting_reason) await evictIfPresent(cur.id)
      if (changes.parent_id !== undefined) {
        const all = await db.todos.toArray()
        const byParent = indexByParent(all)
        if (!isLeafTodo(updated, byParent)) await evictIfPresent(cur.id)
      }
    }
    const ctx = await todoPublicContext()
    return { status: 200, body: publicTodo(updated, ctx) }
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
    if (mindmap) {
      for (const id of ids) await evictIfPresent(id)
    }
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
