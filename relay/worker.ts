/**
 * openNotion relay —— Cloudflare Worker（Durable Object 存每 token 的同步状态）。
 *
 * 协议见 web/src/sync/protocol.ts；核心逻辑见 ./core.mjs（与本地内存版服务器共用）。
 * 鉴权：一个 Bearer token = 一个命名空间（DO id = sha256(token)），不存明文 token。
 *
 * 这里不依赖 @cloudflare/workers-types —— 用最小本地类型声明，部署时无需装任何包。
 */

import { applySync, createState, MAX_CHANGES, MAX_BODY_BYTES } from './core.mjs'
import type { SyncRequest, SyncState } from './core.mjs'

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}

interface DurableObjectState {
  storage: DurableObjectStorage
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}

interface Env {
  SYNC_NAMESPACE: DurableObjectNamespace
}

const VERSION = '0.2.0'

/** Bearer token 最小长度 —— token 是命名空间的唯一凭据 */
const MIN_TOKEN_LEN = 12

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  })
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 每个 token 一个 Durable Object：内部维护 seq、变更 log、按 (entity,id) 的最新版本 */
export class SyncNamespace {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    let req: SyncRequest
    try {
      req = (await request.json()) as SyncRequest
    } catch {
      return json({ error: '请求体不是合法 JSON' }, 400)
    }
    if (!req || typeof req !== 'object') return json({ error: '请求体必须是对象' }, 400)
    if (!Array.isArray(req.changes)) return json({ error: 'changes 必须是数组' }, 400)
    if (req.changes.length > MAX_CHANGES) {
      return json({ error: `单次最多 ${MAX_CHANGES} 条变更（收到 ${req.changes.length} 条）` }, 413)
    }
    if (typeof req.device_id !== 'string' || !req.device_id) {
      return json({ error: '缺少 device_id' }, 400)
    }

    const stored = (await this.state.storage.get<SyncState>('state')) ?? createState()
    const result = applySync(stored, req)
    // ponytail: log 无限增长（每个 token 的全部历史版本）。个人使用量级下可接受；
    // 量大时改成只保留最近 N 条 + 定期 compaction。
    await this.state.storage.put('state', stored)
    return json(result)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // 浏览器（PWA）跨域调用要先过预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    if (url.pathname === '/v1/health') {
      return json({ ok: true, service: 'opennotion-relay', version: VERSION })
    }

    if (url.pathname === '/v1/sync') {
      if (request.method !== 'POST') return json({ error: '请用 POST' }, 405)
      const auth = request.headers.get('authorization') ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
      if (!token) return json({ error: '缺少令牌：请在 Authorization 头里放 Bearer <token>' }, 401)
      // token 即命名空间的全部凭据，太短等于没设防（无速率限制，可被枚举）
      if (token.length < MIN_TOKEN_LEN) {
        return json({ error: `令牌太短：至少 ${MIN_TOKEN_LEN} 个字符，请换一段足够长的随机字符串` }, 403)
      }

      const body = await request.text()
      if (body.length > MAX_BODY_BYTES) {
        return json({ error: `请求体过大（上限 ${Math.round(MAX_BODY_BYTES / 1024)}KB）` }, 413)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        return json({ error: '请求体不是合法 JSON' }, 400)
      }
      const req = parsed as SyncRequest
      if (!Array.isArray(req.changes)) return json({ error: 'changes 必须是数组' }, 400)
      if (req.changes.length > MAX_CHANGES) {
        return json({ error: `单次最多 ${MAX_CHANGES} 条变更（收到 ${req.changes.length} 条）` }, 413)
      }

      const id = env.SYNC_NAMESPACE.idFromName(await sha256Hex(token))
      const stub = env.SYNC_NAMESPACE.get(id)
      // body 已被读过，构造新请求传给 DO
      return stub.fetch(
        new Request(request.url, { method: 'POST', headers: request.headers, body }),
      )
    }

    return json({ error: '未知路径' }, 404)
  },
}
