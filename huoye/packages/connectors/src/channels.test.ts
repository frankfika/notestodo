import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_DEFS,
  ChannelStore,
  channelStatus,
  normalizeChannelId,
  publicChannelView,
  validateChannelValues,
  type ChannelDef,
} from "./index";

function def(id: string): ChannelDef {
  const found = CHANNEL_DEFS.find((item) => item.id === id);
  if (!found) throw new Error("没有这个通道");
  return found;
}

describe("通道目录", () => {
  it("四个通道默认都是未连接，没有 coming_soon", () => {
    expect(CHANNEL_DEFS.map((item) => item.id)).toEqual(["feishu", "lark", "dingtalk", "weixin"]);
    for (const item of CHANNEL_DEFS) {
      expect(item.status).toBe("not_connected");
      expect(item.description).not.toMatch(/即将接入|尚未接通/);
      expect(item.fields.length).toBeGreaterThan(0);
    }
  });

  it("wechat 是微信的别名", () => {
    expect(normalizeChannelId("wechat")).toBe("weixin");
    expect(normalizeChannelId("WEIXIN")).toBe("weixin");
    expect(normalizeChannelId("unknown")).toBeUndefined();
  });

  it("必填项缺一就是未连接，空字符串和空格都算没填", () => {
    const feishu = def("feishu");
    expect(channelStatus(feishu, { appId: "cli_x", appSecret: "s", verificationToken: "t" })).toBe("connected");
    expect(channelStatus(feishu, { appId: "cli_x", appSecret: "  ", verificationToken: "t" })).toBe("not_connected");
    expect(channelStatus(feishu, { appId: "cli_x", appSecret: "s" })).toBe("not_connected");
  });

  it("校验失败时给出中文提示，且不把通道标成已连接", () => {
    const result = validateChannelValues(def("dingtalk"), { appKey: "ding_x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("还没有填完必填项");
  });

  it("公开视图不回显密钥明文，只说是否已配置", () => {
    const view = publicChannelView(def("feishu"), {
      appId: "cli_x",
      appSecret: "super-secret",
      verificationToken: "token-value",
    });
    const secret = view.fields.find((field) => field.key === "appSecret");
    expect(secret?.configured).toBe(true);
    expect(secret?.value).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("super-secret");
    const appId = view.fields.find((field) => field.key === "appId");
    expect(appId?.value).toBe("cli_x");
  });
});

describe("通道凭证存放", () => {
  it("写通道不会覆盖 providers，删通道也不会", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "huoye-channels-"));
    const file = path.join(dir, "secrets.json");
    const store = new ChannelStore(file);
    store.save("feishu", { appId: "cli_x", appSecret: "s", verificationToken: "t" });
    expect(store.status("feishu")).toBe("connected");

    // 模拟模型供应商密钥也在同一个文件里
    const raw = JSON.parse(readFileSync(file, "utf8")) as { providers: Record<string, string>; channels: Record<string, unknown> };
    raw.providers = { mock: "provider-key" };
    writeFileSync(file, JSON.stringify(raw), "utf8");

    store.save("lark", { appId: "cli_l", appSecret: "s2", verificationToken: "t2" });
    const after = JSON.parse(readFileSync(file, "utf8")) as { providers: Record<string, string>; channels: Record<string, unknown> };
    expect(after.providers.mock).toBe("provider-key");
    expect(Object.keys(after.channels)).toEqual(["feishu", "lark"]);

    store.remove("feishu");
    const removed = JSON.parse(readFileSync(file, "utf8")) as { providers: Record<string, string>; channels: Record<string, unknown> };
    expect(removed.providers.mock).toBe("provider-key");
    expect(removed.channels.lark).toBeTruthy();
    expect(store.status("feishu")).toBe("not_connected");
  });
});
