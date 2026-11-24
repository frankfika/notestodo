import { describe, expect, it } from "vitest";
import { selectHomeTasks, taskScheduleLabel, visibleMemoryMarkdown } from "./labels";

describe("memory overview and home tasks", () => {
  it("hides the generator comment from overview markdown", () => {
    const raw = `<!-- 由活页根据 about-you/ 生成，请改源文件。 -->\n\n## 基本档案\n\n- 称呼：方陈\n`;
    const visible = visibleMemoryMarkdown(raw);
    expect(visible).not.toContain("由活页根据");
    expect(visible).toContain("基本档案");

    const quoted = `> 由活页根据 about-you/ 生成，请改源文件。\n\n## 基本档案\n`;
    expect(visibleMemoryMarkdown(quoted)).not.toContain("由活页根据");
  });

  it("hides YAML frontmatter from health notes and recording bodies", () => {
    const raw = `---
id: mem_01test
title: 2026-11-23 的健康记录
kind: other
createdAt: 2026-11-23T13:41:03+08:00
---

## 13:43 · 手记

- 睡眠：大约睡了 6 小时
`;
    const visible = visibleMemoryMarkdown(raw);
    expect(visible).toContain("大约睡了 6 小时");
    expect(visible).not.toContain("id:");
    expect(visible).not.toContain("createdAt:");
    expect(visible).not.toContain("kind:");
  });

  it("hides machine provenance lines from health and recording markdown", () => {
    const health = `## 13:43 · 手记\n\n- 睡眠：大约睡了 6 小时\n- 出处：health:hand\n`;
    const shown = visibleMemoryMarkdown(health);
    expect(shown).toContain("大约睡了 6 小时");
    expect(shown).not.toContain("出处：");
    const recording = `还没有配置可用的语音转写。\n\n- 出处：recording:rec_abc\n`;
    expect(visibleMemoryMarkdown(recording)).toContain("还没有配置可用的语音转写");
    expect(visibleMemoryMarkdown(recording)).not.toContain("出处：");
  });

  it("keeps stale running tasks from hiding today's completed work", () => {
    const items = [
      { id: "old", status: "running", updatedAt: "2026-11-23T11:36:54+08:00", title: "整理桌面备忘" },
      { id: "new", status: "completed", updatedAt: "2026-11-23T12:19:04+08:00", title: "列出三件小事" },
    ];
    const shown = selectHomeTasks(items, "2026-11-23");
    expect(shown.map((item) => item.title)).toContain("列出三件小事");
    expect(shown.map((item) => item.title)).toContain("整理桌面备忘");
  });

  it("describes the next scheduled run in Chinese", () => {
    const now = new Date("2026-11-23T12:45:00+08:00");
    const label = taskScheduleLabel(
      {
        kind: "cron",
        cron: "30 21 * * *",
        timezone: "Asia/Shanghai",
        enabled: true,
        nextRunAt: "2026-11-23T21:30:00+08:00",
      },
      now,
    );
    expect(label).toContain("每天 21:30");
    expect(label).toContain("今天 21:30");
  });
});
