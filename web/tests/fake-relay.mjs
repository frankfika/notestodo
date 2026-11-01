/**
 * 本地内存版 relay —— 与 relay/worker.ts 行为一致（共用 relay/core.mjs），
 * 供客户端 e2e 在无网络环境里跑同步逻辑。零依赖，node 直接 import。
 *
 * 用法：
 *   const relay = await startFakeRelay()
 *   // relay.url → http://127.0.0.1:<port>
 *   await relay.close()
 */
import { createServer } from 'node:http'
import { applySync, createState, MAX_CHANGES, MAX_BODY_BYTES } from '../../relay/core.mjs'

/**
 * @param {{ port?: number }} [opts]
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>, state: Map<string, object> }>}
 */
export function startFakeRelay(opts = {}) {
  /** token → 同步状态（不同 token 空间隔离） */
  const states = new Map()

  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  }

  const server = createServer((req, res) => {
    const send = (body, status = 200) => {
      const text = JSON.stringify(body)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS })
      res.end(text)
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }

    if (req.method === 'GET' && req.url === '/v1/health') {
      return send({ ok: true, service: 'opennotion-relay', version: '0.1.0', fake: true })
    }
    if (req.method !== 'POST' || req.url !== '/v1/sync') {
      return send({ error: '未知路径' }, 404)
    }

    const auth = req.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!token) return send({ error: '缺少令牌：请在 Authorization 头里放 Bearer <token>' }, 401)

    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > MAX_BODY_BYTES) {
        send({ error: `请求体过大（上限 ${Math.round(MAX_BODY_BYTES / 1024)}KB）` }, 413)
        req.destroy()
      }
    })
    req.on('end', () => {
      if (res.writableEnded) return
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return send({ error: '请求体不是合法 JSON' }, 400)
      }
      if (!Array.isArray(parsed.changes)) return send({ error: 'changes 必须是数组' }, 400)
      if (parsed.changes.length > MAX_CHANGES) {
        return send({ error: `单次最多 ${MAX_CHANGES} 条变更（收到 ${parsed.changes.length} 条）` }, 413)
      }
      if (typeof parsed.device_id !== 'string' || !parsed.device_id) {
        return send({ error: '缺少 device_id' }, 400)
      }
      if (!states.has(token)) states.set(token, createState())
      const state = states.get(token)
      send(applySync(state, parsed))
    })
  })

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        state: states,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
