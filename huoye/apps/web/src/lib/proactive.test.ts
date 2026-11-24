import { describe, expect, it } from "vitest";
import { parseProactiveCard as parseSharedCard } from "@huoye/schema";
import {
  defaultActionsFor,
  newestNotification,
  normalizeCard,
  parseLocalCard,
  parseProactiveCard,
  pendingConfirmationCount,
  shouldNotifyWeb,
  type ProactiveCard,
} from "./proactive";

const BRIEF_CARD = {
  kind: "brief",
  title: "早间简报",
  summary: "今天有两件事要办。",
  briefPath: "briefs/2026-11-23-morning.md",
  briefSlot: "morning",
  actions: [
    { id: "view_brief", label: "查看全文" },
    { id: "regenerate_brief", label: "再整理一版" },
  ],
};

const MESSAGE_WITH_CARD = [
  "早间简报整理好了，先放几条要点。",
  "",
  "```huoye-card",
  JSON.stringify(BRIEF_CARD),
  "```",
].join("\n");

describe("parseProactiveCard", () => {
  it("从带围栏的消息里取出卡片，正文里不留围栏", () => {
    const result = parseProactiveCard(MESSAGE_WITH_CARD);
    expect(result.card).toBeDefined();
    expect(result.card?.kind).toBe("brief");
    expect(result.card?.title).toBe("早间简报");
    expect(result.card?.actions.map((action) => action.id)).toEqual(["view_brief", "regenerate_brief"]);
    expect(result.text.trim()).toBe("早间简报整理好了，先放几条要点。");
    expect(result.text).not.toContain("huoye-card");
    expect(result.text).not.toContain("```");
  });

  it("非法 JSON 只返回正文，不抛错", () => {
    const broken = ["正文还在。", "", "```huoye-card", "{不是 JSON", "```"].join("\n");
    let result: { text: string; card?: ProactiveCard } | undefined;
    expect(() => {
      result = parseProactiveCard(broken);
    }).not.toThrow();
    expect(result?.card).toBeUndefined();
    expect(result?.text).toContain("正文还在。");
  });

  it("没有围栏时正文照旧，card 是 undefined", () => {
    const plain = "今天没什么要说的。";
    const result = parseProactiveCard(plain);
    expect(result.card).toBeUndefined();
    expect(result.text).toBe(plain);
  });

  it("围栏没合上时当作普通正文，不吞掉内容", () => {
    const unterminated = ["还没写完的卡片", "```huoye-card", "{\"kind\":\"brief\""].join("\n");
    const result = parseProactiveCard(unterminated);
    expect(result.card).toBeUndefined();
    expect(result.text).toContain("huoye-card");
  });

  it("其它语言的围栏原样保留", () => {
    const content = ["看这段代码：", "```ts", "const a = 1;", "```"].join("\n");
    const result = parseProactiveCard(content);
    expect(result.card).toBeUndefined();
    expect(result.text).toContain("const a = 1;");
  });
});

describe("parseLocalCard", () => {
  it("卡片缺标题或种类不对时不当成卡片", () => {
    const noTitle = ["正文", "", "```huoye-card", JSON.stringify({ kind: "brief" }), "```"].join("\n");
    expect(parseLocalCard(noTitle).card).toBeUndefined();
    const badKind = ["正文", "", "```huoye-card", JSON.stringify({ kind: "unknown", title: "x" }), "```"].join("\n");
    expect(parseLocalCard(badKind).card).toBeUndefined();
  });

  it("本地实现会把坏掉的卡片块摘掉，只留人话", () => {
    const broken = ["正文还在。", "", "```huoye-card", "{不是 JSON", "```"].join("\n");
    const result = parseLocalCard(broken);
    expect(result.card).toBeUndefined();
    expect(result.text).toBe("正文还在。");
  });

  it("动作 id 不在合同清单里会被丢掉", () => {
    const card = normalizeCard({
      kind: "brief",
      title: "简报",
      actions: [{ id: "approve_everything", label: "全部批准" }, { id: "view_brief", label: "查看全文" }],
    });
    expect(card?.actions.map((action) => action.id)).toEqual(["view_brief"]);
  });
});

describe("defaultActionsFor", () => {
  it("按卡片种类给出保守的默认按钮", () => {
    const brief = normalizeCard({ kind: "brief", title: "简报" });
    expect(defaultActionsFor(brief!)).toEqual([
      { id: "view_brief", label: "查看全文" },
      { id: "regenerate_brief", label: "再整理一版" },
    ]);
    const confirmation = normalizeCard({ kind: "confirmation", title: "等你确认" });
    expect(defaultActionsFor(confirmation!)).toEqual([{ id: "open_confirmations", label: "去确认" }]);
    const paused = normalizeCard({ kind: "paused", title: "主动更新已暂停" });
    expect(defaultActionsFor(paused!)).toEqual([{ id: "resume_proactive", label: "恢复主动更新" }]);
    const task = normalizeCard({ kind: "task_result", title: "任务跑完了" });
    expect(defaultActionsFor(task!)).toEqual([{ id: "view_task", label: "查看任务" }]);
  });
});

describe("shouldNotifyWeb", () => {
  const items = [{ id: "n1" }];

  it("页面在前台时不通知", () => {
    expect(shouldNotifyWeb({ hidden: false, supported: true, permission: "granted", items })).toBe(false);
  });

  it("没授权时不通知，也不去索要权限", () => {
    expect(shouldNotifyWeb({ hidden: true, supported: true, permission: "default", items })).toBe(false);
    expect(shouldNotifyWeb({ hidden: true, supported: true, permission: "denied", items })).toBe(false);
  });

  it("浏览器不支持时不通知", () => {
    expect(shouldNotifyWeb({ hidden: true, supported: false, permission: "granted", items })).toBe(false);
  });

  it("没有新通知时不通知", () => {
    expect(shouldNotifyWeb({ hidden: true, supported: true, permission: "granted", items: [] })).toBe(false);
  });

  it("页面不在前台且已授权时才通知", () => {
    expect(shouldNotifyWeb({ hidden: true, supported: true, permission: "granted", items })).toBe(true);
  });
});

describe("newestNotification", () => {
  it("取时间最新的一条", () => {
    const newest = newestNotification([
      { id: "old", title: "旧", body: "旧", at: "2026-11-23T08:00:00.000Z", kind: "brief" },
      { id: "new", title: "新", body: "新", at: "2026-11-23T09:00:00.000Z", kind: "brief" },
    ]);
    expect(newest?.id).toBe("new");
    expect(newestNotification([])).toBeUndefined();
  });
});

describe("pendingConfirmationCount", () => {
  it("数字和列表都能算出条数", () => {
    expect(pendingConfirmationCount(3)).toBe(3);
    expect(pendingConfirmationCount([{ id: "a" }, { id: "b" }])).toBe(2);
    expect(pendingConfirmationCount(undefined)).toBe(0);
  });
});

describe("与 @huoye/schema 的共享实现对得上", () => {
  it("同一段消息，共享实现和本地兜底给出同样的正文与卡片", () => {
    const shared = parseSharedCard(MESSAGE_WITH_CARD);
    const local = parseLocalCard(MESSAGE_WITH_CARD);
    expect(local.text).toBe(shared.text);
    expect(local.card?.kind).toBe(shared.card?.kind);
    expect(local.card?.title).toBe(shared.card?.title);
    expect(local.card?.actions.map((action) => action.id)).toEqual(
      shared.card?.actions.map((action) => action.id),
    );
  });

  it("卡片坏了的时候，两边都不给卡片", () => {
    const broken = ["正文还在。", "", "```huoye-card", "{不是 JSON", "```"].join("\n");
    expect(parseSharedCard(broken).card).toBeUndefined();
    expect(parseLocalCard(broken).card).toBeUndefined();
  });
});
