import { describe, expect, it } from "vitest";
import {
  ConfirmationError,
  ConfirmationService,
  HuoyeDb,
  MockProvider,
  estimateTokens,
  mockReply,
} from "./index";

function service(): { db: HuoyeDb; confirmations: ConfirmationService } {
  const db = new HuoyeDb(":memory:");
  return { db, confirmations: new ConfirmationService(db, "Asia/Shanghai") };
}

describe("@huoye/core confirmations", () => {
  it("creates a pending confirmation for an external write and does not execute it yet", () => {
    const { confirmations } = service();
    let executed = false;
    const req = confirmations.requestExternalWrite({
      action: "feishu.message.send",
      target: "工作群",
      summary: "拟发送一条消息",
      preview: "明天把草稿发过去。",
    });
    expect(req.status).toBe("pending");
    expect(() =>
      confirmations.execute(req.id, () => {
        executed = true;
        return true;
      }),
    ).toThrow(ConfirmationError);
    expect(executed).toBe(false);
  });

  it("executes only after approval", () => {
    const { confirmations } = service();
    const req = confirmations.requestExternalWrite({
      action: "demo.message.send",
      target: "演示会话",
      summary: "拟发送一条消息",
      preview: "你好",
    });
    const approved = confirmations.approve(req.id);
    expect(approved.status).toBe("approved");
    const result = confirmations.execute(req.id, (current) => `sent:${current.preview}`);
    expect(result).toBe("sent:你好");
    expect(() => confirmations.execute(req.id, () => "again")).toThrow(/已经执行/);
  });

  it("treats expired requests as rejected and will not execute them", () => {
    const { confirmations } = service();
    const req = confirmations.requestExternalWrite({
      action: "feishu.message.send",
      target: "工作群",
      summary: "拟发送一条消息",
      preview: "过期测试",
      expiresAt: "2020-01-01T00:00:00+08:00",
    });
    expect(() => confirmations.approve(req.id)).toThrow(ConfirmationError);
    const listed = confirmations.list();
    const found = listed.find((c) => c.id === req.id);
    expect(found?.status).toBe("expired");
    expect(() => confirmations.execute(req.id, () => "nope")).toThrow(/不得执行|过期/);
  });

  it("does not list a seeded demo confirmation as pending", () => {
    const { confirmations } = service();
    const seeded = confirmations.seedDemoIfEmpty();
    expect(seeded?.action).toBe("demo.message.send");
    confirmations.expireSeededDemos();
    const listed = confirmations.list();
    expect(listed.some((item) => item.action === "demo.message.send" && item.status === "pending")).toBe(false);
    expect(listed.filter((item) => item.status === "pending")).toEqual([]);
  });

  it("records a mock completion that can be tokenized", async () => {
    const provider = new MockProvider("mock");
    const result = await provider.complete([{ role: "user", content: "你好" }]);
    expect(result.text).toContain("你好");
    expect(result.text).toContain("叶");
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.inputTokens).toBe(estimateTokens("你好"));
  });
});


describe("@huoye/core mock replies", () => {
  it("lists three concrete items instead of parroting the ask", () => {
    const text = mockReply([{ role: "user", content: "列出三件小事" }], "叶");
    expect(text).toMatch(/1\./);
    expect(text).toMatch(/2\./);
    expect(text).toMatch(/3\./);
    expect(text).not.toContain("我记下了：「列出三件小事」");
  });

  it("puts the late-arrival wording into a draft reply", () => {
    const text = mockReply(
      [{ role: "user", content: "帮我拟一条发给同事的消息，先别发出去，就说明天上午我可能晚到。" }],
      "叶",
    );
    expect(text).toMatch(/晚到/);
    expect(text).toContain("不会发出去");
  });
});
