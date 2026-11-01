# openNotion relay —— 自托管同步服务

一个 Cloudflare Worker，把多台设备的 openNotion 数据同步起来。

- **协议**：`web/src/sync/protocol.ts`（客户端与本服务端严格对齐同一份定义）
- **核心逻辑**：`core.mjs`（Worker 与本地内存版服务器共用同一份，避免两边跑偏）
- **客户端**：`web/src/sync/`（设置页填服务器地址 + 令牌即可）

## 部署

```bash
cd relay
npx wrangler deploy        # 需要 Cloudflare 账号（免费额度足够个人用）
```

部署完拿到地址 `https://opennotion-relay.<your-subdomain>.workers.dev`。

本地试跑：

```bash
npx wrangler dev
```

## 令牌（= 命名空间）

一个随机长字符串就是一个命名空间：

```bash
openssl rand -hex 32
```

服务端只存 **sha256(token)** 作为 Durable Object 的名字（`idFromName`），不存明文。
把同一个令牌填到每台设备的「设置 → 同步 → 令牌」里，它们就共享一个命名空间。

**令牌即密码**：谁拿到谁就能读写你的数据。丢了只能重建（见下方「删除数据」）。

## 接口

### `POST /v1/sync`

请求头：`Authorization: Bearer <token>`

```jsonc
{
  "device_id": "本机 uuid",
  "cursor": 12,              // 已同步到的序号，0 = 全量
  "changes": [               // 待推送的本地变更
    {
      "entity": "notes",     // notes|todos|notebooks|tags|tagBindings|boards|comments
      "id": "...",
      "op": "upsert",        // upsert|delete
      "data": { },           // 实体全量快照；delete 时为 null
      "updated_at": "2026-11-01T10:00:00.000Z",
      "sync_version": 3,
      "deleted_at": null
    }
  ]
}
```

响应：

```jsonc
{
  "cursor": 20,              // 客户端保存为下次拉取起点
  "server_time": "...",
  "changes": [ ],            // 比 cursor 新、且不是本设备产生的变更
  "conflicts": [ ]           // 并发冲突（见下）
}
```

### `GET /v1/health`

`{"ok":true,"service":"opennotion-relay","version":"0.1.0"}`

## 冲突策略

服务端按 **(updated_at, device_id)** 决胜：同一 `entity:id` 只保留一份胜出版本，
输的一方进 `conflicts` 列表，客户端据此**保留本地版本 + 生成一份「冲突副本」**——
数据永不丢，合并交给用户。

删除用软删语义（`op:"delete"`、`deleted_at` 有值、`data:null`）。

## 限制

- 单请求最多 **500 条**变更，body 上限 **1MB**（超了返回 413）
- 每个 token 的变更 log 目前**无限增长**（个人量级无碍；量大时要加 compaction）

## 数据在哪 / 怎么删

每个 token = 一个 Durable Object，id = `sha256(token)` 的哈希名。

- 备份：Durable Object 存储（DO id → state blob）
- 删除：删掉对应 DO 即可（`wrangler delete` 或后台管理），删后该 token 的所有同步数据消失，
  设备重新同步会当作全新命名空间（各设备本地数据仍在，重新推送即可）

## 测试

`web/tests/fake-relay.mjs` 是同协议的内存版服务器（共用 `core.mjs`），客户端 e2e 直接起它，
不需要网络：

```js
import { startFakeRelay } from '../web/tests/fake-relay.mjs'
const relay = await startFakeRelay()   // relay.url / relay.close()
```
