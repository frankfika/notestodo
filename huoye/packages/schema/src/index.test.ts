import { describe, expect, it } from "vitest";
import {
  chatMessageSchema,
  confirmationRequestSchema,
  briefTimeOfDayTitle,
  civilToIso,
  formatFriendlyLocalTime,
  formatIso,
  memoryFileSchema,
  memorySearchHitSchema,
  settingsSchema,
  taskSchema,
  usageEventSchema,
} from "./index";

describe("@huoye/schema", () => {
  it("accepts a valid memory file", () => {
    const parsed = memoryFileSchema.parse({
      id: "mem_abc",
      relativePath: "about-you/profile.md",
      title: "基本档案",
      kind: "about_you",
      pinned: false,
      readonly: false,
      content: "hello",
      frontmatter: { title: "基本档案" },
      revision: "abc123",
      bytes: 5,
      createdAt: "2026-11-23T10:00:00+08:00",
      updatedAt: "2026-11-23T10:00:00+08:00",
    });
    expect(parsed.kind).toBe("about_you");
  });

  it("rejects an unknown memory kind and a path-less file", () => {
    expect(() =>
      memoryFileSchema.parse({
        id: "mem_x",
        relativePath: "about-you/profile.md",
        title: "x",
        kind: "secret",
        pinned: false,
        readonly: false,
        content: "",
        frontmatter: {},
        revision: "r",
        bytes: 0,
        createdAt: "2026-11-23T10:00:00+08:00",
        updatedAt: "2026-11-23T10:00:00+08:00",
      }),
    ).toThrow();
    expect(() =>
      memoryFileSchema.parse({
        id: "mem_x",
        relativePath: "",
        title: "x",
        kind: "other",
        pinned: false,
        readonly: false,
        content: "",
        frontmatter: {},
        revision: "r",
        bytes: 0,
        createdAt: "2026-11-23T10:00:00+08:00",
        updatedAt: "2026-11-23T10:00:00+08:00",
      }),
    ).toThrow();
  });

  it("accepts a valid task and rejects an empty title", () => {
    const task = taskSchema.parse({
      id: "tsk_1",
      kind: "on_demand",
      title: "整理本周笔记",
      instruction: "把日记里的待办提取出来",
      status: "draft",
      confirmationIds: [],
      createdAt: "2026-11-23T10:00:00+08:00",
      updatedAt: "2026-11-23T10:00:00+08:00",
    });
    expect(task.status).toBe("draft");
    expect(() =>
      taskSchema.parse({ ...task, title: "" }),
    ).toThrow();
  });

  it("accepts a confirmation and rejects a bad status", () => {
    const cnf = confirmationRequestSchema.parse({
      id: "cnf_1",
      createdAt: "2026-11-23T10:00:00+08:00",
      status: "pending",
      risk: "low",
      action: "demo.message.send",
      target: "演示会话",
      summary: "拟发送一条消息",
      preview: "你好",
      editable: true,
      toolPayload: { text: "你好" },
    });
    expect(cnf.editable).toBe(true);
    expect(() => confirmationRequestSchema.parse({ ...cnf, status: "maybe" })).toThrow();
  });

  it("accepts a usage event and rejects negative tokens", () => {
    const ev = usageEventSchema.parse({
      id: "use_1",
      at: "2026-11-23T10:00:00+08:00",
      provider: "mock",
      model: "mock-ye",
      purpose: "conversation",
      inputTokens: 4,
      outputTokens: 8,
      totalTokens: 12,
      source: "byok",
    });
    expect(ev.totalTokens).toBe(12);
    expect(() => usageEventSchema.parse({ ...ev, inputTokens: -1 })).toThrow();
  });

  it("fills onboardingCompleted by default and rejects a bad language", () => {
    const settings = settingsSchema.parse({
      language: "zh-CN",
      timezone: "Asia/Shanghai",
      displayName: "你",
      assistantName: "叶",
      proactivity: "off",
      autoAcceptLowRiskMemoryPatches: false,
      memoryReflectEnabled: false,
      providers: [],
    });
    expect(settings.onboardingCompleted).toBe(false);
    expect(() => settingsSchema.parse({ ...settings, language: "ja" })).toThrow();
  });

  it("accepts a chat message and a search hit", () => {
    const msg = chatMessageSchema.parse({
      id: "msg_1",
      chatId: "cht_1",
      role: "assistant",
      content: "你好",
      createdAt: "2026-11-23T10:00:00+08:00",
    });
    expect(msg.role).toBe("assistant");
    const hit = memorySearchHitSchema.parse({
      path: "about-you/work.md",
      title: "工作与项目",
      snippet: "正在做的事",
      score: 1,
    });
    expect(hit.score).toBe(1);
  });

  it("formats ISO timestamps with an offset, not Z", () => {
    const iso = formatIso(new Date("2026-11-23T02:00:00.000Z"), "Asia/Shanghai");
    expect(iso).toBe("2026-11-23T10:00:00+08:00");
  });

  it("formats a friendly Asia/Shanghai time for the brief footer", () => {
    expect(formatFriendlyLocalTime(new Date("2026-11-23T14:20:29+08:00"), "Asia/Shanghai")).toBe(
      "11月23日 14:20",
    );
    expect(formatFriendlyLocalTime(new Date("2026-11-23T14:20:29+08:00"), "Asia/Shanghai")).not.toMatch(/T\d{2}:/);
  });

  it("labels 12:41 as 午间简报, not 早间简报", () => {
    expect(briefTimeOfDayTitle(8)).toBe("早间简报");
    expect(briefTimeOfDayTitle(12)).toBe("午间简报");
    expect(briefTimeOfDayTitle(15)).toBe("下午简报");
    expect(briefTimeOfDayTitle(21)).toBe("晚间简报");
  });

  it("interprets datetime-local strings in the given timezone", () => {
    expect(civilToIso("2026-11-23T12:41", "Asia/Shanghai")).toBe("2026-11-23T12:41:00+08:00");
    expect(civilToIso("2026-11-23T12:41:00+08:00", "Asia/Shanghai")).toBe("2026-11-23T12:41:00+08:00");
  });
});
