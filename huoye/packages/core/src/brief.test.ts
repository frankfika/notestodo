import { describe, expect, it } from "vitest";
import {
  EVENING_HOUR,
  MORNING_HOUR,
  buildLocalBrief,
  currentBriefSlot,
  dateHeading,
  nextAnchor,
  summarizeAboutYou,
  selectBriefDiaryFacts,
  selectHealthFacts,
  synthesizeBrief,
  modelFallbackMessage,
} from "./brief";
import { timeOfDayGreeting } from "@huoye/schema";

const TIME_ZONE = "Asia/Shanghai";

function at(hour: number): Date {
  return new Date(`2026-11-23T${String(hour).padStart(2, "0")}:30:00+08:00`);
}

describe("@huoye/core brief", () => {
  it("keeps the anchor hours at 08:00 and 21:00", () => {
    expect(MORNING_HOUR).toBe(8);
    expect(EVENING_HOUR).toBe(21);
  });

  it("maps local hours to slots and the next anchor", () => {
    expect(currentBriefSlot(at(8), TIME_ZONE)).toBe("morning");
    expect(currentBriefSlot(at(20), TIME_ZONE)).toBe("morning");
    expect(currentBriefSlot(at(21), TIME_ZONE)).toBe("evening");
    expect(currentBriefSlot(at(3), TIME_ZONE)).toBe("evening");
    expect(nextAnchor(at(10), TIME_ZONE)).toMatchObject({ slot: "evening", hour: 21 });
    expect(nextAnchor(at(10), TIME_ZONE).label).toContain("21:00");
    expect(nextAnchor(at(22), TIME_ZONE)).toMatchObject({ slot: "morning", hour: 8 });
    expect(nextAnchor(at(22), TIME_ZONE).label).toContain("08:00");
  });

  it("formats the date heading with Intl", () => {
    const heading = dateHeading(new Date("2026-11-23T09:00:00+08:00"), TIME_ZONE);
    expect(heading).toContain("11月23日");
    expect(heading).toMatch(/星期/);
  });

  it("summarizes only filled list items and skips teaching paragraphs", () => {
    const files = [
      {
        title: "基本档案",
        content:
          "---\ntitle: 基本档案\n---\n\n# 基本档案\n\n- 称呼：方陈\n- 所在城市：上海\n- 时区：\n\n把你希望活页记住的基本信息写在这里。\n",
      },
    ];
    const facts = summarizeAboutYou(files);
    expect(facts).toEqual(["称呼：方陈", "所在城市：上海"]);
    expect(facts.join("\n")).not.toContain("把你希望活页记住");
  });

  it("writes a human brief for an empty profile and no tasks", () => {
    const text = buildLocalBrief({
      now: new Date("2026-11-23T09:00:00+08:00"),
      timeZone: TIME_ZONE,
      facts: [],
      openTaskTitles: [],
    });
    expect(text).toContain("11月23日");
    expect(text).toContain("早上好");
    expect(text).toContain("手头还没有未完成的任务");
    expect(text).not.toContain("基本档案");
    expect(text).not.toContain("slice");
  });

  it("mentions known facts without pasting the profile", () => {
    const text = buildLocalBrief({
      now: new Date("2026-11-23T09:00:00+08:00"),
      timeZone: TIME_ZONE,
      displayName: "方陈",
      facts: ["称呼：方陈", "所在城市：上海", "正在做的事：产品"],
      openTaskTitles: ["整理桌面"],
    });
    expect(text).toContain("方陈");
    expect(text).toContain("上海");
    expect(text).toContain("整理桌面");
    expect(text).not.toContain("基本档案");
    expect(text).not.toContain("由活页根据");
    expect(text.length).toBeLessThan(280);
  });

  it("falls back to the local brief when the provider is mock", async () => {
    const result = await synthesizeBrief({
      now: new Date("2026-11-23T09:00:00+08:00"),
      timeZone: TIME_ZONE,
      facts: [],
      openTaskTitles: [],
      provider: { type: "mock", complete: async () => ({ text: "", inputTokens: 0, outputTokens: 0 }) },
    });
    expect(result.usedModel).toBe(false);
    expect(result.source).toBe("local");
    expect(result.text.length).toBeGreaterThan(0);
  });
});


describe("@huoye/core brief greeting and diary facts", () => {
  it("uses 下午好 at 12:19, matching the home greeting", () => {
    expect(timeOfDayGreeting(12)).toBe("下午好");
    const text = buildLocalBrief({
      now: new Date("2026-11-23T12:19:00+08:00"),
      timeZone: TIME_ZONE,
      displayName: "方陈",
      facts: ["称呼：方陈"],
      openTaskTitles: [],
    });
    expect(text).toContain("下午好");
    expect(text).not.toContain("上午好");
  });

  it("keeps recent diary facts and drops stitched chat or task logs", () => {
    const selected = selectBriefDiaryFacts([
      "我叫方陈，在上海，做产品，晚上不喜欢被打断",
      "帮我拟一条发给同事的消息，先别发出去，就说明天上午我可能晚到。",
      "任务「列出三件小事」已处理：我记下了：「列出三件小事」。",
      "晚上还是不喜欢被打断",
      "下周要去杭州出差三天",
    ]);
    expect(selected.join(" ")).toContain("杭州出差");
    expect(selected.join(" ")).toContain("方陈");
    expect(selected.join(" ")).not.toContain("还是");
    expect(selected.join(" ")).not.toContain("先别发出去");
    expect(selected.join(" ")).not.toContain("已处理");
    const text = buildLocalBrief({
      now: new Date("2026-11-23T12:19:00+08:00"),
      timeZone: TIME_ZONE,
      displayName: "方陈",
      facts: ["称呼：方陈", "所在城市：上海"],
      openTaskTitles: [],
      diaryFacts: [
        "帮我拟一条发给同事的消息，先别发出去",
        "任务「整理桌面」已处理：我看到了你刚说的那一段",
        "下周要去杭州出差三天",
      ],
    });
    expect(text).toContain("杭州出差");
    expect(text).toContain("今天记下了");
    expect(text).not.toContain("先别发出去");
    expect(text).not.toContain("已处理");
  });

  it("mentions today's health note without dumping the file", () => {
    const facts = selectHealthFacts([
      "睡眠：大约睡了 7 小时",
      "活动：走了半小时",
      "出处：health:hand",
      "",
    ]);
    expect(facts).toEqual(["睡眠：大约睡了 7 小时", "活动：走了半小时"]);
    const text = buildLocalBrief({
      now: new Date("2026-11-23T12:19:00+08:00"),
      timeZone: TIME_ZONE,
      displayName: "方陈",
      facts: ["称呼：方陈"],
      openTaskTitles: [],
      healthFacts: [
        "睡眠：大约睡了 7 小时",
        "活动：走了半小时",
        "出处：health:hand",
      ],
    });
    expect(text).toContain("今天的健康记录里写了");
    expect(text).toContain("大约睡了 7 小时");
    expect(text).toContain("走了半小时");
    expect(text).not.toContain("出处：");
    expect(text).not.toContain("---");
    expect(text).not.toContain("kind:");
  });

  it("prefers the latest health append when the same fields appear twice", () => {
    const facts = selectHealthFacts([
      "睡眠：大约睡了 7 小时",
      "活动：走了半小时",
      "心情：平静",
      "睡眠：大约睡了 6 小时",
      "活动：下午散步 20 分钟",
      "心情：还好",
      "备注：QA标记：health-ui-1",
    ]);
    expect(facts).toEqual([
      "睡眠：大约睡了 6 小时",
      "活动：下午散步 20 分钟",
      "心情：还好",
      "备注：QA标记：health-ui-1",
    ]);
    const text = buildLocalBrief({
      now: new Date("2026-11-23T13:45:00+08:00"),
      timeZone: TIME_ZONE,
      displayName: "方陈",
      facts: ["称呼：方陈"],
      openTaskTitles: [],
      healthFacts: facts,
    });
    expect(text).toContain("大约睡了 6 小时");
    expect(text).toContain("下午散步 20 分钟");
    expect(text).toContain("QA标记：health-ui-1");
    expect(text).not.toContain("7 小时");
  });

  it("asks the model to greet with 下午好 and include the latest health facts", async () => {
    let prompt = "";
    const provider = {
      type: "openai_compatible" as const,
      complete: async (messages: Array<{ role: "user" | "assistant" | "system"; content: string }>) => {
        prompt = messages.map((m) => m.content).join("\n");
        return {
          text: "下午好，方陈。你昨晚大约睡了 6 小时，下午散了二十分钟步，心情还好。",
          inputTokens: 11,
          outputTokens: 17,
        };
      },
    };
    const result = await synthesizeBrief({
      now: new Date("2026-11-23T15:10:00+08:00"),
      timeZone: TIME_ZONE,
      displayName: "方陈",
      facts: ["称呼：方陈"],
      openTaskTitles: [],
      healthFacts: [
        "睡眠：大约睡了 7 小时",
        "活动：走了半小时",
        "心情：平静",
        "睡眠：大约睡了 6 小时",
        "活动：下午散步 20 分钟",
        "心情：还好",
      ],
      provider,
    });
    expect(result.source).toBe("model");
    expect(result.usedModel).toBe(true);
    expect(result.fallbackMessage).toBeUndefined();
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(17);
    expect(result.text).toContain("下午好");
    expect(prompt).toContain("问候请用「下午好」");
    expect(prompt).not.toContain("问候请用「早上好」");
    expect(prompt).toContain("大约睡了 6 小时");
    expect(prompt).toContain("下午散步 20 分钟");
    expect(prompt).not.toContain("大约睡了 7 小时");
  });

  it("falls back honestly to a local brief when the configured model fails", async () => {
    const result = await synthesizeBrief({
      now: new Date("2026-11-23T15:10:00+08:00"),
      timeZone: TIME_ZONE,
      displayName: "方陈",
      facts: ["称呼：方陈"],
      openTaskTitles: [],
      healthFacts: ["睡眠：大约睡了 6 小时"],
      provider: {
        type: "openai_compatible",
        complete: async () => {
          throw new Error("模型接口请求失败（500）");
        },
      },
    });
    expect(result.source).toBe("local");
    expect(result.usedModel).toBe(false);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.fallbackMessage).toContain("本地档案");
    expect(result.text).toContain("下午好");
    expect(result.text).toContain("大约睡了 6 小时");
  });


  it("keeps model failure reasons honest and short, without leaking key-like tokens", () => {
    const message = modelFallbackMessage(
      new Error(
        '模型接口请求失败（429）：{"type":"error","error":{"message":"已达到 Token Plan 用量上限：请升级套餐。 (2056)"}}',
      ),
    );
    expect(message).toContain("已达到 Token Plan 用量上限");
    expect(message).toContain("本地档案");
    expect(message).not.toMatch(/\{/);
    expect(message).not.toContain("request_id");
    expect(modelFallbackMessage(new Error("模型接口请求失败（500）"))).toContain("接口返回 500");
    expect(modelFallbackMessage(new Error("sk-forbidden-token-should-not-appear"))).toBe(
      "模型这次没有写出来，已改用本地档案整理一版。",
    );
  });

});
