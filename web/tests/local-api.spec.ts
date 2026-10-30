/**
 * 开放 API 路由层（web/src/api/localApi.ts 的 routeApiRequest）：
 * 任务的增删改查 / 过滤与校验、子树软删、笔记读写、错误路径。
 * HTTP/Tauri 事件外壳在桌面版联调；这里用同样的 ApiRequest 形状直调路由。
 */
import { test, expect, type Page } from '@playwright/test'

const BASE = process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/'

async function seed(page: Page): Promise<void> {
  await page.goto(BASE)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    await db.kv.put({ key: 'onboarding_done_v1', value: true })
    await db.todos.clear()
    await db.notes.clear()
    await db.tags.clear()
    await db.tagBindings.clear()
    const ts = new Date().toISOString()
    const base = { status: 'open', source: 'manual', created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 }
    await db.todos.bulkPut([
      { id: 'O', kind: 'objective', scope: 'strategic', parent_id: null, title: '战略 O', sort_order: 10 },
      { id: 'KR', kind: 'kr', scope: 'strategic', parent_id: 'O', title: 'KR 甲', sort_order: 20 },
      { id: 't1', kind: 'task', scope: 'strategic', parent_id: 'KR', title: '写周报', sort_order: 30 },
      { id: 't2', kind: 'task', scope: null, parent_id: null, title: '买牛奶', sort_order: 40 },
      { id: 'done1', kind: 'task', scope: null, parent_id: null, title: '已完成的事', status: 'done', sort_order: 50 },
    ].map((r) => ({ ...base, ...r })))
    await db.tags.put({ id: 'tag1', name: '工作', created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 })
    await db.tagBindings.put({ id: 'b1', tag_id: 'tag1', target_type: 'todo', target_id: 't1', created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 })
    await db.notes.put({ id: 'n1', title: '会议纪要', body_md: '# 本周\n- 对齐 OKR', todo_ids: [], pinned: false, created_at: ts, updated_at: ts, deleted_at: null, sync_version: 0 })
    await db.notes.put({ id: 'nDel', title: '已删笔记', body_md: '不该被看见', todo_ids: [], pinned: false, created_at: ts, updated_at: ts, deleted_at: ts, sync_version: 0 })
  })
}

type ApiReq = { req_id: number; method: string; path: string; query: string; body: string }

function call(page: Page, method: string, path: string, body?: unknown, query = ''): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async ({ method, path, body, query }) => {
    const { routeApiRequest } = await import('/src/api/localApi.ts')
    const req: ApiReq = { req_id: 1, method, path, query, body: body === undefined ? '' : JSON.stringify(body) }
    const r = await routeApiRequest(req)
    return { status: r.status, body: r.body }
  }, { method, path, body, query })
}

test('任务：列表过滤 / 创建（含层级校验）/ 更新 / 子树软删', async ({ page }) => {
  await seed(page)

  // 列表 + 过滤
  let r = await call(page, 'GET', '/todos')
  expect(r.status).toBe(200)
  expect((r.body as { id: string }[]).map((t) => t.id)).toEqual(['O', 'KR', 't1', 't2', 'done1'])
  r = await call(page, 'GET', '/todos', undefined, 'status=done')
  expect((r.body as { id: string }[]).map((t) => t.id)).toEqual(['done1'])
  r = await call(page, 'GET', '/todos', undefined, 'q=牛奶')
  expect((r.body as { id: string }[]).map((t) => t.id)).toEqual(['t2'])

  // 创建：Inbox 任务
  r = await call(page, 'POST', '/todos', { title: 'API 新建任务' })
  expect(r.status).toBe(201)
  const created = r.body as { id: string; parent_id: string | null; kind: string }
  expect(created.parent_id).toBeNull()

  // 创建：挂到合法父节点 + 非法父节点被拒（task 挂 task 现在合法 = 大任务拆小任务）
  r = await call(page, 'POST', '/todos', { title: '挂到 KR', parent_id: 'KR' })
  expect(r.status).toBe(201)
  expect((r.body as { parent_id: string }).parent_id).toBe('KR')
  r = await call(page, 'POST', '/todos', { title: '大任务拆小', parent_id: 't1' })
  expect(r.status).toBe(201)
  r = await call(page, 'POST', '/todos', { title: '不存在父', parent_id: 'ghost' })
  expect(r.status).toBe(400)
  r = await call(page, 'POST', '/todos', { title: '   ' })
  expect(r.status).toBe(400)

  // 更新：完成 + 校验
  r = await call(page, 'PATCH', '/todos/t2', { status: 'done' })
  expect(r.status).toBe(200)
  expect((r.body as { status: string }).status).toBe('done')
  r = await call(page, 'PATCH', '/todos/t2', { status: 'nope' })
  expect(r.status).toBe(400)
  r = await call(page, 'PATCH', '/todos/不存在', { status: 'done' })
  expect(r.status).toBe(404)

  // 子树软删：O → KR → t1（t1 下还有新建的"大任务拆小"）全走，tag 绑定同步软删
  r = await call(page, 'DELETE', '/todos/O')
  expect(r.status).toBe(200)
  expect((r.body as { deleted: number }).deleted).toBe(5)
  const after = await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const todos = await db.todos.toArray()
    const binding = await db.tagBindings.get('b1')
    return { deleted: todos.filter((t) => t.deleted_at !== null).map((t) => t.id), bindingDeleted: binding?.deleted_at != null }
  })
  expect(after.deleted).toEqual(expect.arrayContaining(['O', 'KR', 't1']))
  expect(after.deleted).toHaveLength(5)
  expect(after.bindingDeleted).toBe(true)
})

test('笔记：列表 / 搜索 / 创建 / 详情；错误路径', async ({ page }) => {
  await seed(page)

  let r = await call(page, 'GET', '/notes')
  expect(r.status).toBe(200)
  expect((r.body as { id: string }[]).map((n) => n.id)).toEqual(['n1'])
  r = await call(page, 'GET', '/notes', undefined, 'q=OKR')
  expect((r.body as unknown[]).length).toBe(1)

  r = await call(page, 'POST', '/notes', { title: 'API 笔记', body_md: '## 内容' })
  expect(r.status).toBe(201)
  const id = (r.body as { id: string }).id
  r = await call(page, 'GET', `/notes/${id}`)
  expect((r.body as { body_md: string }).body_md).toBe('## 内容')
  r = await call(page, 'GET', '/notes/不存在')
  expect(r.status).toBe(404)
  // 软删笔记：列表不出现，详情 404
  const ids = (r.body && (await call(page, 'GET', '/notes')).body) as { id: string }[]
  expect(ids.map((n) => n.id)).not.toContain('nDel')
  expect((await call(page, 'GET', '/notes/nDel')).status).toBe(404)

  // 坏 JSON body / 未知路由
  const bad = await page.evaluate(async () => {
    const { routeApiRequest } = await import('/src/api/localApi.ts')
    return routeApiRequest({ req_id: 1, method: 'POST', path: '/todos', query: '', body: '{oops' })
  })
  expect(bad.status).toBe(400)
  r = await call(page, 'GET', '/nope')
  expect(r.status).toBe(404)
})
