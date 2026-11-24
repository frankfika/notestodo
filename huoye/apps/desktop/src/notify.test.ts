import { describe, expect, it } from "vitest";
import {
  DESKTOP_NOTIFICATION_BODY_LIMIT,
  desktopNotificationBody,
  desktopNotificationTitle,
  shouldNotifyDesktop,
  type DesktopNotificationItem,
} from "./notify";

function makeItem(overrides: Partial<DesktopNotificationItem> = {}): DesktopNotificationItem {
  return {
    id: "n-1",
    title: "早间简报",
    body: "今天的简报已经整理好了。",
    at: "2026-11-23T09:00:00.000Z",
    kind: "brief",
    ...overrides,
  };
}

describe("桌面通知的触发条件", () => {
  it("窗口在前台时不通知", () => {
    expect(shouldNotifyDesktop({ focused: true, permission: "granted", items: [makeItem()] })).toBe(false);
  });

  it("用户没有授权系统通知时不通知", () => {
    for (const permission of ["denied", "default", "", "Granted"]) {
      expect(shouldNotifyDesktop({ focused: false, permission, items: [makeItem()] })).toBe(false);
    }
  });

  it("没有待推通知时不通知", () => {
    expect(shouldNotifyDesktop({ focused: false, permission: "granted", items: [] })).toBe(false);
  });

  it("不在前台、已授权、有待推通知时才通知", () => {
    expect(shouldNotifyDesktop({ focused: false, permission: "granted", items: [makeItem()] })).toBe(true);
  });
});

describe("桌面通知的文案", () => {
  it("标题带中文前缀和中文内容", () => {
    const title = desktopNotificationTitle(makeItem());
    expect(title).toContain("活页");
    expect(title).toContain("早间简报");
    expect(title).toMatch(/[\u4e00-\u9fa5]/);
  });

  it("标题缺失时也有中文兜底", () => {
    const title = desktopNotificationTitle(makeItem({ title: "   ", kind: "confirmation" }));
    expect(title).toMatch(/[\u4e00-\u9fa5]/);
    expect(title).toContain("待确认");
  });

  it("正文超过 60 字就截断到 60 字以内", () => {
    const body = desktopNotificationBody(makeItem({ body: "活".repeat(120) }));
    expect(Array.from(body).length).toBeLessThanOrEqual(DESKTOP_NOTIFICATION_BODY_LIMIT);
    expect(body.endsWith("…")).toBe(true);
    expect(body.startsWith("活活")).toBe(true);
  });

  it("正文本来就短时原样返回", () => {
    expect(desktopNotificationBody(makeItem({ body: "短通知" }))).toBe("短通知");
  });

  it("正文为空时给一句中文兜底", () => {
    const body = desktopNotificationBody(makeItem({ body: "   " }));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/[\u4e00-\u9fa5]/);
  });
});
