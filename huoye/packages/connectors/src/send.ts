/**
 * 官方发送通道。只有通道已连接、并且确实有目的地（webhook 或最近一次会话对象）时才会发请求。
 * fetch 可以注入，测试里不会打到公网。
 */

import type { ChannelDef, ChannelId } from "./channels";
import { dingtalkWebhookSignature, feishuWebhookSignature } from "./signatures";

export interface ChannelSendInput {
  channelId: ChannelId;
  def: ChannelDef;
  values: Record<string, string>;
  text: string;
  /** 最近的会话对象：飞书 chat_id / 钉钉 conversationId / 微信 openid。 */
  destination?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ChannelSendResult {
  ok: boolean;
  message: string;
  via?: string;
}

export const NO_DESTINATION_MESSAGE = "通道已配置，但还没有可投递的会话，没有发出去。";

export async function sendChannelMessage(input: ChannelSendInput): Promise<ChannelSendResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const values = input.values ?? {};
  const webhook = (values.webhookUrl ?? "").trim();
  const secret = (values.webhookSecret ?? "").trim();
  const destination = (input.destination ?? "").trim();

  if (webhook && input.channelId !== "weixin") {
    return sendWebhook(input, doFetch, webhook, secret);
  }
  if (destination) {
    if (input.channelId === "feishu" || input.channelId === "lark") {
      return sendFeishuMessage(input, doFetch, destination);
    }
    if (input.channelId === "weixin") {
      return sendWechatMessage(input, doFetch, destination);
    }
  }
  return { ok: true, message: NO_DESTINATION_MESSAGE };
}

async function sendWebhook(
  input: ChannelSendInput,
  doFetch: typeof fetch,
  webhook: string,
  secret: string,
): Promise<ChannelSendResult> {
  const now = (input.now ?? (() => Date.now()))();
  const timestamp = String(Math.floor(now / 1000));
  let url = webhook;
  let body: unknown;

  if (input.channelId === "dingtalk") {
    body = { msgtype: "text", text: { content: input.text } };
    if (secret) {
      const sign = dingtalkWebhookSignature(timestamp, secret);
      url = appendQuery(url, { timestamp, sign });
    }
  } else {
    body = { msg_type: "text", content: { text: input.text } };
    if (secret) {
      const sign = feishuWebhookSignature(timestamp, secret);
      url = appendQuery(url, { timestamp, sign });
    }
  }

  const response = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return {
      ok: false,
      message: `发送失败：官方接口返回 ${response.status}。`,
      via: "webhook",
    };
  }
  const text = await safeText(response);
  if (text && /error|failed|not ok/i.test(text) && !/"code"\s*:\s*0/.test(text)) {
    return { ok: false, message: `发送失败：官方接口返回了错误。${text.slice(0, 120)}`, via: "webhook" };
  }
  return { ok: true, message: `已通过官方接口发到${input.def.name}。`, via: "webhook" };
}

async function sendFeishuMessage(
  input: ChannelSendInput,
  doFetch: typeof fetch,
  destination: string,
): Promise<ChannelSendResult> {
  const values = input.values;
  const tokenResponse = await doFetch(`${input.def.apiBase}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: values.appId, app_secret: values.appSecret }),
  });
  if (!tokenResponse.ok) {
    return { ok: false, message: `发送失败：取应用凭证失败（${tokenResponse.status}）。`, via: "open-api" };
  }
  const tokenBody = (await safeJson(tokenResponse)) as { tenant_access_token?: string; code?: number };
  const token = tokenBody?.tenant_access_token;
  if (!token) {
    return { ok: false, message: "发送失败：开放平台没有返回应用凭证。", via: "open-api" };
  }
  const response = await doFetch(
    `${input.def.apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: destination,
        msg_type: "text",
        content: JSON.stringify({ text: input.text }),
      }),
    },
  );
  if (!response.ok) {
    return { ok: false, message: `发送失败：官方接口返回 ${response.status}。`, via: "open-api" };
  }
  const body = (await safeJson(response)) as { code?: number; msg?: string };
  if (typeof body?.code === "number" && body.code !== 0) {
    return { ok: false, message: `发送失败：${body.msg ?? "官方接口返回了错误"}。`, via: "open-api" };
  }
  return { ok: true, message: `已通过官方接口发到${input.def.name}。`, via: "open-api" };
}

async function sendWechatMessage(
  input: ChannelSendInput,
  doFetch: typeof fetch,
  destination: string,
): Promise<ChannelSendResult> {
  const values = input.values;
  const tokenUrl = `${input.def.apiBase}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
    values.appId ?? "",
  )}&secret=${encodeURIComponent(values.appSecret ?? "")}`;
  const tokenResponse = await doFetch(tokenUrl, { method: "GET" });
  if (!tokenResponse.ok) {
    return { ok: false, message: `发送失败：取 access_token 失败（${tokenResponse.status}）。`, via: "open-api" };
  }
  const tokenBody = (await safeJson(tokenResponse)) as { access_token?: string; errcode?: number; errmsg?: string };
  const token = tokenBody?.access_token;
  if (!token) {
    return { ok: false, message: `发送失败：${tokenBody?.errmsg ?? "没有拿到 access_token"}。`, via: "open-api" };
  }
  const response = await doFetch(
    `${input.def.apiBase}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        touser: destination,
        msgtype: "text",
        text: { content: input.text },
      }),
    },
  );
  if (!response.ok) {
    return { ok: false, message: `发送失败：官方接口返回 ${response.status}。`, via: "open-api" };
  }
  const body = (await safeJson(response)) as { errcode?: number; errmsg?: string };
  if (typeof body?.errcode === "number" && body.errcode !== 0) {
    return { ok: false, message: `发送失败：${body.errmsg ?? "官方接口返回了错误"}。`, via: "open-api" };
  }
  return { ok: true, message: "已通过官方接口发到微信。", via: "open-api" };
}

function appendQuery(url: string, params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  if (!query) return url;
  return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}
