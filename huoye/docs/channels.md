# 通道

活页支持四个一等聊天通道：飞书、Lark、钉钉、微信。每个通道在设置 → 通道里都有真实的配置面板；没有配齐必填凭证时，状态就是「未连接」，不会出现「已连接」。

通道只使用官方开放平台的协议与算法：

- 飞书 / Lark：开放平台应用凭证 + 事件订阅回调（同一套签名规则，接口地址不同）。
- 钉钉：机器人 HTTP 模式接收消息，事件订阅推送需要验签。
- 微信：公众号 / 服务号的官方回调（token + SHA1 签名）。**不使用个人微信协议、不做 hook、不做非官方协议。**

## 字段

| 通道 | 必填 | 可选 |
| --- | --- | --- |
| 飞书 / Lark | `appId`、`appSecret`、`verificationToken` | `encryptKey`、`webhookUrl`、`webhookSecret` |
| 钉钉 | `appKey`、`appSecret` | `robotCode`、`corpId`、`callbackToken`、`encodingAesKey`、`webhookUrl`、`webhookSecret` |
| 微信 | `appId`、`appSecret`、`token` | `encodingAesKey` |

必填项缺任意一个都算未连接；空字符串和只有空格都算没填。密钥只写进本机的 `secrets.json`（权限 0600）的 `channels` 字段，和模型供应商的 `providers` 并存，接口读回时只告诉你「是否已配置」，不回显明文。

在设置页填写后保存，或直接调用接口：

```bash
curl -X PUT http://127.0.0.1:8787/api/channels/feishu \
  -H 'content-type: application/json' \
  -d '{"appId":"cli_xxx","appSecret":"...","verificationToken":"..."}'
```

- `GET /api/channels`：通道列表（公开字段回显当前值，密钥只有 `configured`）。
- `GET /api/channels/:id`：单个通道。
- `PUT /api/channels/:id`：保存凭证；缺必填返回 400，通道保持未连接。
- `DELETE /api/channels/:id`：移除凭证，状态回到未连接。

## 本机回调路径

本机 API 默认绑 `127.0.0.1`，开放平台需要一个公网可达的地址，所以要你自己做一层映射（内网穿透、隧道或反向代理），再把公网地址指到下面的本机路径：

| 通道 | 回调路径 |
| --- | --- |
| 飞书 | `POST /api/channels/feishu/event` |
| Lark | `POST /api/channels/lark/event` |
| 钉钉 | `POST /api/channels/dingtalk/event` |
| 微信 | `GET` / `POST /api/channels/wechat/event`（`/api/channels/weixin/event` 是同一个路径的别名） |

校验规则：

- 飞书 / Lark：配置了 Encrypt Key 时按官方 `sha256(timestamp + nonce + encryptKey + 原始请求体)` 校验 `X-Lark-Signature`，密文按官方 AES-256-CBC 解开；没有 Encrypt Key 时校验事件里的 Verification Token。URL 验证请求会原样回 `challenge`。
- 钉钉：机器人 HTTP 模式用请求头的 `timestamp` 与 `sign`（`Base64(HmacSHA256(timestamp + "\n" + appSecret, appSecret))`）校验，时间戳与本机相差超过一小时视为非法；事件订阅推送用 query 里的 `msg_signature` / `timestamp` / `nonce` 校验 `sha1(join(sort([token, timestamp, nonce, encrypt])))`。
- 微信：GET 验证与 POST 消息都用 query 的 `signature` 校验 `sha1(join(sort([token, timestamp, nonce])))`，验证通过时原样返回 `echostr`。

签名不过或通道没配置时一律返回 401，不会写聊天，也不会写日记。

## 本地模拟器

不想先申请一个真实租户，可以直接用模拟器写一条入站消息。它会照常写聊天和日记，出处会写明是模拟器，而且**不会**把通道标成已连接：

```bash
curl -X POST http://127.0.0.1:8787/api/channels/feishu/simulate \
  -H 'content-type: application/json' \
  -d '{"text":"今晚可能晚到","senderLabel":"我"}'
```

## 出站

对外发消息永远先走确认卡。你说「拟一条发到飞书的消息，先别发出去」时，活页只会起草并请求确认。

- 通道未连接 → 批准后记下「已记下，没有发出去（通道未连接）」，不会调用任何发送接口。
- 通道已连接但没有可投递的会话 → 「通道已配置，但还没有可投递的会话，没有发出去。」
- 通道已连接并且有目的地（自定义机器人 webhook，或最近一次入站记下的 chat_id / conversationId / openid）→ 才真正调用官方发送接口；成功就说已通过官方接口发出，失败就说失败原因。

飞书 / Lark / 钉钉优先走官方自定义机器人 webhook；配了 webhook 签名密钥时会按官方算法带签。微信没有群机器人 webhook，走公众号 / 服务号客服消息接口。

## 已知边界

- 钉钉事件订阅会按官方布局加解密，并用 JSON 回包 `{ msg_signature, timeStamp, nonce, encrypt }` 返回加密的 `success`；`check_url` 校验请求不会写成聊天或日记。对话入站仍建议优先用机器人 HTTP 模式，真实租户上的事件订阅还需要你在开放平台配好回调地址。
- 微信的安全模式（`EncodingAESKey`）目前只收集字段，尚未解密消息体；明文模式的签名校验已经生效。
- 后续如果要做微信的官方协议扩展，可以参考腾讯 `Tencent/openclaw-weixin`（MIT，iLink）这条路；本刀没有接入 iLink。

## 官方文档

- 飞书 / Lark 事件订阅：<https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server>
- 钉钉机器人接收消息：<https://open.dingtalk.com/document/group/receive-message>
- 钉钉事件订阅 HTTP 推送：<https://open.dingtalk.com/document/orgapp/develop-http-push-server>
- 微信公众平台服务器配置：<https://developers.weixin.qq.com/doc/subscription/guide/dev/push/>
