/**
 * 通道目录：飞书 / Lark / 钉钉 / 微信。
 * 只有官方开放平台协议在范围内；微信只做公众号 / 服务号官方回调。
 */

export type ChannelId = "feishu" | "lark" | "dingtalk" | "weixin";
export type ChannelStatus = "not_connected" | "connected" | "error";
export type ChannelFieldType = "text" | "secret";

export interface ChannelFieldDef {
  key: string;
  label: string;
  type: ChannelFieldType;
  required: boolean;
  placeholder: string;
  help?: string;
}

export interface ChannelDef {
  id: ChannelId;
  name: string;
  kind: "channel";
  status: ChannelStatus;
  capabilities: Array<"read" | "send">;
  description: string;
  setupHint: string;
  eventPath: string;
  fields: ChannelFieldDef[];
  apiBase: string;
  docsUrl: string;
}

export interface PublicChannelField {
  key: string;
  label: string;
  type: ChannelFieldType;
  required: boolean;
  placeholder: string;
  help?: string;
  /** 公开字段回显当前值；密钥字段只有 configured，不回显明文。 */
  value?: string;
  configured?: boolean;
}

export interface PublicChannel {
  id: string;
  name: string;
  kind: "channel";
  status: ChannelStatus;
  description: string;
  setupHint: string;
  eventPath: string;
  fields: PublicChannelField[];
  capabilities: string[];
}

const FEISHU_DOCS =
  "https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/event-subscription-configure-/choose-a-subscription-mode/send-notifications-to-developers-server";
const DINGTALK_ROBOT_DOCS = "https://open.dingtalk.com/document/group/receive-message";
const WECHAT_DOCS = "https://developers.weixin.qq.com/doc/subscription/guide/dev/push/";

export const CHANNEL_DEFS: ChannelDef[] = [
  {
    id: "feishu",
    name: "飞书",
    kind: "channel",
    status: "not_connected",
    capabilities: ["read", "send"],
    description: "在飞书里和活页对话。使用飞书开放平台的应用凭证与事件回调，消息只在你批准之后才发出去。",
    setupHint: "在飞书开放平台创建应用，把事件回调地址指向本机的 /api/channels/feishu/event，填好下面的凭证即可。详见仓库 docs/channels.md 与官方文档。",
    eventPath: "/api/channels/feishu/event",
    apiBase: "https://open.feishu.cn",
    docsUrl: FEISHU_DOCS,
    fields: [
      { key: "appId", label: "App ID", type: "text", required: true, placeholder: "cli_xxxxxxxx", help: "开放平台应用的 App ID" },
      { key: "appSecret", label: "App Secret", type: "secret", required: true, placeholder: "请输入 App Secret", help: "只保存在本机 secrets.json" },
      { key: "verificationToken", label: "Verification Token", type: "secret", required: true, placeholder: "请输入事件订阅的校验 Token", help: "用来校验事件是不是官方平台发来的" },
      { key: "encryptKey", label: "Encrypt Key", type: "secret", required: false, placeholder: "留空表示不做加密传输", help: "填了就按官方 AES 算法解密事件" },
      { key: "webhookUrl", label: "自定义机器人 Webhook", type: "secret", required: false, placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/..." },
      { key: "webhookSecret", label: "Webhook 签名密钥", type: "secret", required: false, placeholder: "机器人签名校验用的密钥" },
    ],
  },
  {
    id: "lark",
    name: "Lark",
    kind: "channel",
    status: "not_connected",
    capabilities: ["read", "send"],
    description: "Lark 是飞书的国际版，用同一套事件签名规则，开放平台地址不同。",
    setupHint: "在 Lark 开放平台创建应用，把事件回调地址指向本机的 /api/channels/lark/event，填好下面的凭证即可。详见仓库 docs/channels.md 与官方文档。",
    eventPath: "/api/channels/lark/event",
    apiBase: "https://open.larkoffice.com",
    docsUrl: FEISHU_DOCS,
    fields: [
      { key: "appId", label: "App ID", type: "text", required: true, placeholder: "cli_xxxxxxxx" },
      { key: "appSecret", label: "App Secret", type: "secret", required: true, placeholder: "请输入 App Secret" },
      { key: "verificationToken", label: "Verification Token", type: "secret", required: true, placeholder: "请输入事件订阅的校验 Token" },
      { key: "encryptKey", label: "Encrypt Key", type: "secret", required: false, placeholder: "留空表示不做加密传输" },
      { key: "webhookUrl", label: "自定义机器人 Webhook", type: "secret", required: false, placeholder: "https://open.larksuite.com/open-apis/bot/v2/hook/..." },
      { key: "webhookSecret", label: "Webhook 签名密钥", type: "secret", required: false, placeholder: "机器人签名校验用的密钥" },
    ],
  },
  {
    id: "dingtalk",
    name: "钉钉",
    kind: "channel",
    status: "not_connected",
    capabilities: ["read", "send"],
    description: "在钉钉里和活页对话。使用钉钉开放平台的机器人 HTTP 模式接收消息，用官方自定义机器人 Webhook 发出消息。",
    setupHint: "在钉钉开放平台建应用，把机器人 HTTP 模式的地址指向本机的 /api/channels/dingtalk/event，填好下面的凭证即可。详见仓库 docs/channels.md 与官方文档。",
    eventPath: "/api/channels/dingtalk/event",
    apiBase: "https://api.dingtalk.com",
    docsUrl: DINGTALK_ROBOT_DOCS,
    fields: [
      { key: "appKey", label: "AppKey", type: "text", required: true, placeholder: "ding_xxxxxxxx" },
      { key: "appSecret", label: "AppSecret", type: "secret", required: true, placeholder: "请输入 AppSecret" },
      { key: "robotCode", label: "机器人 Code", type: "text", required: false, placeholder: "钉钉机器人的 code" },
      { key: "corpId", label: "企业 CorpId", type: "text", required: false, placeholder: "ding_xxxxxxxx" },
      { key: "callbackToken", label: "事件订阅 Token", type: "secret", required: false, placeholder: "事件订阅回调的 token" },
      { key: "encodingAesKey", label: "EncodingAESKey", type: "secret", required: false, placeholder: "事件订阅的加解密密钥" },
      { key: "webhookUrl", label: "自定义机器人 Webhook", type: "secret", required: false, placeholder: "https://oapi.dingtalk.com/robot/send?access_token=..." },
      { key: "webhookSecret", label: "Webhook 签名密钥", type: "secret", required: false, placeholder: "加签模式用的密钥" },
    ],
  },
  {
    id: "weixin",
    name: "微信",
    kind: "channel",
    status: "not_connected",
    capabilities: ["read", "send"],
    description: "用公众号或服务号的官方回调接入，不使用个人微信协议。",
    setupHint: "在公众平台开启服务器配置，把 URL 指向本机的 /api/channels/wechat/event，填好 Token 与下面的凭证即可。详见仓库 docs/channels.md 与官方文档。",
    eventPath: "/api/channels/wechat/event",
    apiBase: "https://api.weixin.qq.com",
    docsUrl: WECHAT_DOCS,
    fields: [
      { key: "appId", label: "AppID", type: "text", required: true, placeholder: "wx1234567890" },
      { key: "appSecret", label: "AppSecret", type: "secret", required: true, placeholder: "请输入 AppSecret" },
      { key: "token", label: "Token", type: "secret", required: true, placeholder: "公众平台服务器配置里的 Token" },
      { key: "encodingAesKey", label: "EncodingAESKey", type: "secret", required: false, placeholder: "安全模式的消息加密密钥" },
    ],
  },
];

/** 事件路由允许用 `wechat` 作为微信的别名。 */
const ALIASES: Record<string, ChannelId> = {
  feishu: "feishu",
  lark: "lark",
  dingtalk: "dingtalk",
  weixin: "weixin",
  wechat: "weixin",
};

export function normalizeChannelId(id: string): ChannelId | undefined {
  return ALIASES[String(id ?? "").trim().toLowerCase()];
}

export function channelDefById(id: string): ChannelDef | undefined {
  const normalized = normalizeChannelId(id);
  if (!normalized) return undefined;
  return CHANNEL_DEFS.find((item) => item.id === normalized);
}

export function channelName(id: ChannelId): string {
  return CHANNEL_DEFS.find((item) => item.id === id)?.name ?? id;
}

/** 空字符串或只有空格都算没填。 */
export function normalizeValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function missingRequiredFields(def: ChannelDef, values: Record<string, string>): string[] {
  return def.fields
    .filter((field) => field.required && !normalizeValue(values[field.key]))
    .map((field) => field.label);
}

/** 必填项全部填好才算已连接，缺一即未连接。 */
export function channelStatus(def: ChannelDef, values: Record<string, string>): ChannelStatus {
  return missingRequiredFields(def, values).length === 0 ? "connected" : "not_connected";
}

export interface ChannelValidation {
  ok: boolean;
  error?: string;
  values: Record<string, string>;
}

export function validateChannelValues(
  def: ChannelDef,
  input: Record<string, unknown>,
): ChannelValidation {
  const values: Record<string, string> = {};
  for (const field of def.fields) {
    values[field.key] = normalizeValue(input[field.key]);
  }
  const missing = missingRequiredFields(def, values);
  if (missing.length) {
    return {
      ok: false,
      error: "还没有填完必填项，通道仍是未连接。",
      values,
    };
  }
  return { ok: true, values };
}

export function publicChannelView(def: ChannelDef, values: Record<string, string>): PublicChannel {
  return {
    id: def.id,
    name: def.name,
    kind: "channel",
    status: channelStatus(def, values),
    description: def.description,
    setupHint: def.setupHint,
    eventPath: def.eventPath,
    capabilities: def.capabilities,
    fields: def.fields.map((field) => {
      const current = normalizeValue(values[field.key]);
      if (field.type === "secret") {
        return {
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required,
          placeholder: current ? "已保存，不回显；要更换请重新输入" : field.placeholder,
          ...(field.help ? { help: field.help } : {}),
          configured: Boolean(current),
        };
      }
      return {
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        placeholder: field.placeholder,
        ...(field.help ? { help: field.help } : {}),
        value: current,
      };
    }),
  };
}
