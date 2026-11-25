/**
 * 把各平台的入站事件解析成统一形状：文本、发件人、来源引用、可回复的会话对象。
 */

export interface InboundEvent {
  text: string;
  senderLabel: string;
  sourceRef: string;
  /** 可回复的会话对象：飞书 chat_id / 钉钉 conversationId / 微信 openid。 */
  replyTo?: string;
  eventId?: string;
  nonText?: boolean;
}

const NON_TEXT_TEXT = "收到一条非文本消息";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** 飞书 / Lark 事件订阅 2.0 的消息事件。 */
export function parseFeishuEvent(body: unknown, channelId: "feishu" | "lark"): InboundEvent {
  const record = asRecord(body);
  const header = asRecord(record.header);
  const event = asRecord(record.event);
  const sender = asRecord(event.sender);
  const senderId = asRecord(sender.sender_id);
  const message = asRecord(event.message);
  const messageType = typeof message.message_type === "string" ? message.message_type : "";
  const sourceRef = `channel:${channelId}`;
  const eventId = typeof header.event_id === "string" ? header.event_id : undefined;

  if (messageType && messageType !== "text") {
    return {
      text: NON_TEXT_TEXT,
      senderLabel: typeof senderId.open_id === "string" ? senderId.open_id : "对方",
      sourceRef,
      ...(eventId ? { eventId } : {}),
      nonText: true,
    };
  }

  const text = parseFeishuContent(message.content);
  const chatId = typeof message.chat_id === "string" ? message.chat_id : undefined;
  return {
    text: text ?? NON_TEXT_TEXT,
    senderLabel: typeof senderId.open_id === "string" ? senderId.open_id : "对方",
    sourceRef,
    ...(chatId ? { replyTo: chatId } : {}),
    ...(eventId ? { eventId } : {}),
    ...(text ? {} : { nonText: true }),
  };
}

function parseFeishuContent(content: unknown): string | undefined {
  if (typeof content !== "string" || !content.trim()) return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    const record = asRecord(parsed);
    const text = record.text;
    return typeof text === "string" && text.trim() ? text.trim() : undefined;
  } catch {
    return content.trim();
  }
}

/** 钉钉机器人 HTTP 模式的明文 body。 */
export function parseDingtalkRobotBody(body: unknown): InboundEvent {
  const record = asRecord(body);
  const text = asRecord(record.text);
  const content = typeof text.content === "string" ? text.content.trim() : "";
  const senderNick = typeof record.senderNick === "string" ? record.senderNick.trim() : "";
  const staffId = typeof record.senderStaffId === "string" ? record.senderStaffId.trim() : "";
  const conversationId = typeof record.conversationId === "string" ? record.conversationId.trim() : "";
  return {
    text: content || NON_TEXT_TEXT,
    senderLabel: senderNick || staffId || "对方",
    sourceRef: "channel:dingtalk",
    ...(conversationId ? { replyTo: conversationId } : {}),
  };
}

/** 钉钉事件订阅解密后的 body。 */
export function parseDingtalkEventPayload(payload: unknown): InboundEvent {
  const record = asRecord(payload);
  const content = typeof record.content === "string" ? record.content.trim() : "";
  const senderNick = typeof record.senderNick === "string" ? record.senderNick.trim() : "";
  const staffId = typeof record.senderStaffId === "string" ? record.senderStaffId.trim() : "";
  const conversationId = typeof record.conversationId === "string" ? record.conversationId.trim() : "";
  const eventId = typeof record.eventId === "string" ? record.eventId : undefined;
  return {
    text: content || NON_TEXT_TEXT,
    senderLabel: senderNick || staffId || "对方",
    sourceRef: "channel:dingtalk",
    ...(conversationId ? { replyTo: conversationId } : {}),
    ...(eventId ? { eventId } : {}),
  };
}

/** 公众号 / 服务号的明文 XML。 */
export function parseWechatXml(xml: string): InboundEvent {
  const field = (name: string): string => {
    const cdata = xml.match(new RegExp(`<${name}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${name}>`));
    if (cdata?.[1]) return cdata[1].trim();
    const plain = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return plain?.[1]?.trim() ?? "";
  };
  const msgType = field("MsgType");
  const content = field("Content");
  const from = field("FromUserName");
  const msgId = field("MsgId");
  const isText = !msgType || msgType === "text";
  return {
    text: isText && content ? content : NON_TEXT_TEXT,
    senderLabel: from || "对方",
    sourceRef: "channel:weixin",
    ...(from ? { replyTo: from } : {}),
    ...(msgId ? { eventId: msgId } : {}),
    ...(isText ? {} : { nonText: true }),
  };
}
