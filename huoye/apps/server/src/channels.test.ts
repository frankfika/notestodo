import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

type App = ReturnType<typeof createApp>["app"];

function tempApp(options: { fetchImpl?: typeof fetch } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "huoye-channels-"));
  const created = createApp({ home, fetchImpl: options.fetchImpl });
  return { app: created.app, workspace: created.workspace };
}

function todayStamp(timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

async function say(app: App, chatId: string, content: string): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/chats/${chatId}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const events = await readSse(res);
  const done = events.find((event) => event.type === "done");
  expect(done).toBeTruthy();
  return done!;
}

async function newChat(app: App): Promise<string> {
  const res = await app.request("/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "测试" }),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

const FEISHU_SECRET = { appId: "cli_test", appSecret: "app-secret", verificationToken: "vtoken" };

describe("通道状态必须诚实", () => {
  it("默认四个通道都是未连接，读回没有密钥明文", async () => {
    const { app } = tempApp();
    const res = await app.request("/api/channels");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; status: string; fields: Array<{ type: string; configured?: boolean }> }> };
    expect(body.items.map((item) => item.id)).toEqual(["feishu", "lark", "dingtalk", "weixin"]);
    for (const item of body.items) {
      expect(item.status).toBe("not_connected");
      for (const field of item.fields) {
        if (field.type === "secret") expect(field.configured).toBe(false);
      }
    }
  });

  it("空保存和缺必填都是 400，通道仍是未连接", async () => {
    const { app } = tempApp();
    const empty = await app.request("/api/channels/feishu", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    const emptyBody = (await empty.json()) as { error: string };
    expect(emptyBody.error).toContain("还没有填完必填项");

    const partial = await app.request("/api/channels/feishu", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "cli_test" }),
    });
    expect(partial.status).toBe(400);

    const after = (await (await app.request("/api/channels/feishu")).json()) as { status: string };
    expect(after.status).toBe("not_connected");
  });

  it("填齐必填才算已连接，密钥不回显，移除后回到未连接", async () => {
    const { app } = tempApp();
    const saved = await app.request("/api/channels/feishu", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FEISHU_SECRET),
    });
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as {
      status: string;
      fields: Array<{ key: string; configured?: boolean; value?: string }>;
    };
    expect(view.status).toBe("connected");
    const secretField = view.fields.find((field) => field.key === "appSecret");
    expect(secretField?.configured).toBe(true);
    expect(secretField?.value).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("app-secret");

    const listed = await app.request("/api/channels");
    const listBody = (await listed.json()) as { items: Array<{ id: string; status: string }> };
    expect(listBody.items.find((item) => item.id === "feishu")?.status).toBe("connected");
    expect(JSON.stringify(listBody)).not.toContain("app-secret");

    const removed = await app.request("/api/channels/feishu", { method: "DELETE" });
    expect(removed.status).toBe(200);
    const removedBody = (await removed.json()) as { status: string };
    expect(removedBody.status).toBe("not_connected");
  });

  it("连接器页只管本地文件夹和云应用，不混入通道", async () => {
    const { app } = tempApp();
    const res = await app.request("/api/connectors");
    const body = (await res.json()) as { items: Array<{ kind: string; status: string }> };
    expect(body.items.every((item) => item.kind !== "channel")).toBe(true);
    expect(body.items.every((item) => item.status !== "coming_soon")).toBe(true);
  });
});

describe("入站事件", () => {
  it("没配置通道时打到官方事件路径是 401，聊天和日记都没有新内容", async () => {
    const { app, workspace } = tempApp();
    const res = await app.request("/api/channels/feishu/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: "2.0", header: { token: "vtoken" }, event: {} }),
    });
    expect(res.status).toBe(401);
    const chats = (await (await app.request("/api/chats")).json()) as { items: Array<{ title: string }> };
    expect(chats.items.some((chat) => chat.title === "飞书")).toBe(false);
    expect(() => workspace.memory.readFile(`diaries/${todayStamp()}.md`)).toThrow();
  });

  it("签名不对是 401，聊天和日记都没有新内容", async () => {
    const { app, workspace } = tempApp();
    await app.request("/api/channels/feishu", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FEISHU_SECRET),
    });
    const res = await app.request("/api/channels/feishu/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: { event_id: "evt_1", event_type: "im.message.receive_v1", token: "wrong-token" },
        event: {
          sender: { sender_id: { open_id: "ou_1" } },
          message: { message_id: "om_1", chat_id: "oc_1", message_type: "text", content: JSON.stringify({ text: "你好" }) },
        },
      }),
    });
    expect(res.status).toBe(401);
    const chats = (await (await app.request("/api/chats")).json()) as { items: Array<{ title: string }> };
    expect(chats.items.some((chat) => chat.title === "飞书")).toBe(false);
    expect(() => workspace.memory.readFile(`diaries/${todayStamp()}.md`)).toThrow();
  });

  it("官方签名通过后写入聊天和日记，出处是结构化的通道来源", async () => {
    const { app, workspace } = tempApp();
    await app.request("/api/channels/feishu", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FEISHU_SECRET),
    });
    const res = await app.request("/api/channels/feishu/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: { event_id: "evt_1", event_type: "im.message.receive_v1", token: "vtoken" },
        event: {
          sender: { sender_id: { open_id: "ou_1" } },
          message: { message_id: "om_1", chat_id: "oc_1", message_type: "text", content: JSON.stringify({ text: "你好" }) },
        },
      }),
    });
    expect([200, 201]).toContain(res.status);

    const chats = (await (await app.request("/api/chats")).json()) as { items: Array<{ id: string; title: string }> };
    const chat = chats.items.find((item) => item.title === "飞书");
    expect(chat).toBeTruthy();
    const messages = (await (await app.request(`/api/chats/${chat!.id}/messages`)).json()) as {
      items: Array<{ content: string }>;
    };
    expect(messages.items.some((item) => item.content.includes("你好"))).toBe(true);

    const diary = workspace.memory.readFile(`diaries/${todayStamp()}.md`);
    expect(diary.content).toContain("来自飞书");
    expect(diary.content).toContain("channel:feishu");
  });

  it("微信的 URL 验证校验签名后原样返回 echostr", async () => {
    const { app } = tempApp();
    await app.request("/api/channels/weixin", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "wx1", appSecret: "s", token: "wtoken" }),
    });
    const { signWechatCallback } = await import("@huoye/connectors");
    const signature = signWechatCallback({ token: "wtoken", timestamp: "1700000000", nonce: "n1" });
    const bad = await app.request(
      `/api/channels/wechat/event?signature=${"0".repeat(40)}&timestamp=1700000000&nonce=n1&echostr=hello`,
    );
    expect(bad.status).toBe(401);
    const ok = await app.request(
      `/api/channels/wechat/event?signature=${signature}&timestamp=1700000000&nonce=n1&echostr=hello`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("hello");
  });

  it("模拟器可以在没连接时写入，出处写明是模拟器，通道仍是未连接", async () => {
    const { app, workspace } = tempApp();
    const res = await app.request("/api/channels/lark/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "模拟一条消息", senderLabel: "测试" }),
    });
    expect([200, 201]).toContain(res.status);
    const status = (await (await app.request("/api/channels/lark")).json()) as { status: string };
    expect(status.status).toBe("not_connected");
    const diary = workspace.memory.readFile(`diaries/${todayStamp()}.md`);
    expect(diary.content).toContain("channel:lark/simulator");
  });

  it("钉钉事件订阅的 check_url 校验通过后不写聊天和日记，回包是官方 JSON", async () => {
    const { app, workspace } = tempApp();
    const encodingAesKey = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64").replace(/=$/, "");
    await app.request("/api/channels/dingtalk", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appKey: "dingapp",
        appSecret: "ding-secret",
        callbackToken: "cb-token",
        encodingAesKey,
      }),
    });
    const { encryptDingtalkEvent, signDingtalkEvent, decryptDingtalkEvent } = await import("@huoye/connectors");
    const encrypt = encryptDingtalkEvent(JSON.stringify({ EventType: "check_url" }), encodingAesKey, "dingapp");
    const timestamp = "1700000000";
    const nonce = "n1";
    const signature = signDingtalkEvent({ token: "cb-token", timestamp, nonce, encrypt });
    const res = await app.request(
      `/api/channels/dingtalk/event?msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ encrypt }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { msg_signature: string; timeStamp: string; nonce: string; encrypt: string };
    expect(body.timeStamp).toBe(timestamp);
    expect(body.nonce).toBe(nonce);
    expect(decryptDingtalkEvent(body.encrypt, encodingAesKey, "dingapp")).toBe("success");
    const chats = (await (await app.request("/api/chats")).json()) as { items: Array<{ title: string }> };
    expect(chats.items.some((chat) => chat.title === "钉钉")).toBe(false);
    expect(() => workspace.memory.readFile(`diaries/${todayStamp()}.md`)).toThrow();
  });

});

describe("通道出站必须先确认，而且没连接就说没连接", () => {
  it("拟一条发到飞书的消息会变成通道确认，批准后诚实说没有发出去", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      throw new Error("不应该发出请求");
    };
    const { app } = tempApp({ fetchImpl });
    const chatId = await newChat(app);
    const done = await say(app, chatId, "拟一条发到飞书的消息，先别发出去，就说明天可能晚到");
    const memory = done.memory as {
      confirmations: Array<{ id: string; action: string; connectorId?: string; summary: string; preview: string }>;
    };
    const draft = memory.confirmations.find((item) => item.action === "channel.message.send");
    expect(draft).toBeTruthy();
    expect(draft!.connectorId).toBe("feishu");
    expect(draft!.summary).toContain("飞书");
    expect(draft!.preview).toContain("晚到");

    const approved = await app.request(`/api/confirmations/${draft!.id}/approve`, { method: "POST" });
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as { executed: { ok: boolean; message: string } };
    expect(body.executed.message).toBe("已记下，没有发出去（通道未连接）");
    expect(called).toBe(false);
  });

  it("原来的「拟一条发给同事的消息」仍然走 message.draft.send", async () => {
    const { app } = tempApp();
    const chatId = await newChat(app);
    const done = await say(app, chatId, "帮我拟一条发给同事的消息，先别发出去");
    const memory = done.memory as { confirmations: Array<{ id: string; action: string }> };
    const draft = memory.confirmations.find((item) => item.action === "message.draft.send");
    expect(draft).toBeTruthy();
    const approved = await app.request(`/api/confirmations/${draft!.id}/approve`, { method: "POST" });
    const body = (await approved.json()) as { executed: { ok: boolean; message: string } };
    expect(body.executed.message).toBe("已记下，这条消息没有发出去。");
  });
});
