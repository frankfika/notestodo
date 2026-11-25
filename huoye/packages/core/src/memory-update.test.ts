import { describe, expect, it } from "vitest";
import { applyFieldReplacements, extractMemoryUpdate, matchNoteIntent } from "./memory-update";

const aboutYou = [
  {
    relativePath: "about-you/profile.md",
    title: "基本档案",
    content: "---\ntitle: 基本档案\n---\n\n# 基本档案\n\n- 称呼：\n- 时区：Asia/Shanghai\n- 所在城市：\n- 常用语言：中文\n",
  },
  {
    relativePath: "about-you/work.md",
    title: "工作与项目",
    content: "---\ntitle: 工作与项目\n---\n\n# 工作与项目\n\n- 正在做的事：\n- 合作对象：\n",
  },
  {
    relativePath: "about-you/lifestyle.md",
    title: "生活习惯",
    content: "---\ntitle: 生活习惯\n---\n\n# 生活习惯\n\n- 作息：\n- 兴趣：\n",
  },
];

describe("@huoye/core memory-update", () => {
  it("extracts diary facts and three patches without mutating the profile", async () => {
    const before = JSON.stringify(aboutYou);
    const result = await extractMemoryUpdate({
      userText: "我叫方陈，在上海做产品，晚上不喜欢被打断",
      assistantText: "我记下了。",
      aboutYou,
    });
    expect(result.usedModel).toBe(false);
    expect(result.diaryFacts.length).toBeGreaterThan(0);
    const fact = result.diaryFacts[0]!.fact;
    expect(fact).toContain("方陈");
    expect(fact).toContain("上海");
    expect(fact).toContain("产品");
    expect(fact).toContain("晚上不喜欢被打断");

    const targets = result.patches.map((p) => p.targetPath);
    expect(targets).toContain("about-you/profile.md");
    expect(targets).toContain("about-you/work.md");
    expect(targets).toContain("about-you/lifestyle.md");

    const profile = result.patches.find((p) => p.targetPath === "about-you/profile.md")!;
    expect(profile.replacements).toEqual(
      expect.arrayContaining([
        { field: "称呼", value: "方陈" },
        { field: "所在城市", value: "上海" },
      ]),
    );
    expect(profile.preview).toContain("称呼：方陈");

    const work = result.patches.find((p) => p.targetPath === "about-you/work.md")!;
    expect(work.replacements.some((r) => r.field === "正在做的事" && r.value.includes("产品"))).toBe(true);

    const lifestyle = result.patches.find((p) => p.targetPath === "about-you/lifestyle.md")!;
    expect(lifestyle.preview.length).toBeGreaterThan(0);
    expect(lifestyle.preview).toContain("作息");

    expect(JSON.stringify(aboutYou)).toBe(before);
  });

  it("does not write a diary or patch for a plain greeting", async () => {
    const result = await extractMemoryUpdate({
      userText: "你好！",
      assistantText: "你好。",
      aboutYou,
    });
    expect(result.diaryFacts).toEqual([]);
    expect(result.patches).toEqual([]);
    expect(result.outboundDraft).toBeUndefined();
  });

  it("creates an outbound draft when the user asks to draft but not send", async () => {
    const result = await extractMemoryUpdate({
      userText: "帮我拟一条发给同事的消息，先别发出去",
      assistantText: "好，我先拟着。",
      aboutYou,
    });
    expect(result.outboundDraft).toBeTruthy();
    expect(result.outboundDraft!.action).toBe("message.draft.send");
    expect(result.outboundDraft!.target).toBe("同事");
    expect(result.outboundDraft!.summary).toContain("消息");
    expect(result.outboundDraft!.preview.length).toBeGreaterThan(0);
    expect(result.outboundDraft!.preview).not.toContain("已发送");
  });

  it("does not propose a patch when the profile already holds the same value", async () => {
    const filled = aboutYou.map((file) =>
      file.relativePath === "about-you/profile.md"
        ? { ...file, content: file.content.replace("- 称呼：", "- 称呼：方陈").replace("- 所在城市：", "- 所在城市：上海") }
        : file,
    );
    const result = await extractMemoryUpdate({
      userText: "我叫方陈，在上海做产品",
      assistantText: "好。",
      aboutYou: filled,
    });
    const profile = result.patches.find((p) => p.targetPath === "about-you/profile.md");
    expect(profile).toBeUndefined();
  });
});


  it("records a Hangzhou trip and does not patch a known evening preference", async () => {
    const filled = aboutYou.map((file) =>
      file.relativePath === "about-you/lifestyle.md"
        ? { ...file, content: file.content.replace("- 作息：", "- 作息：晚上不喜欢被打断") }
        : file,
    );
    const utterance = "记一下：我下周要去杭州出差三天，晚上还是不喜欢被打断。";
    const result = await extractMemoryUpdate({
      userText: utterance,
      assistantText: "我记下了。",
      aboutYou: filled,
    });
    expect(result.usedModel).toBe(false);
    const facts = result.diaryFacts.map((item) => item.fact).join(" ");
    expect(facts).toMatch(/杭州出差/);
    expect(facts).toMatch(/三天/);
    expect(facts).toMatch(/下周/);
    expect(result.patches.find((p) => p.targetPath === "about-you/lifestyle.md")).toBeUndefined();
    expect(JSON.stringify(result.patches)).not.toContain("还是");
  });

  it("canonicalizes filler words when the preference is new", async () => {
    const result = await extractMemoryUpdate({
      userText: "记一下：我下周要去杭州出差三天，晚上还是不喜欢被打断。",
      assistantText: "好。",
      aboutYou,
    });
    const facts = result.diaryFacts.map((item) => item.fact).join(" ");
    expect(facts).toMatch(/杭州出差/);
    const lifestyle = result.patches.find((p) => p.targetPath === "about-you/lifestyle.md");
    expect(lifestyle).toBeTruthy();
    expect(lifestyle!.replacements[0]!.value).toBe("晚上不喜欢被打断");
    expect(lifestyle!.preview).not.toContain("还是");
  });

  it("drafts the late-arrival message and does not treat it as a diary fact", async () => {
    const utterance = "帮我拟一条发给同事的消息，先别发出去，就说明天上午我可能晚到。";
    const result = await extractMemoryUpdate({
      userText: utterance,
      assistantText: "好，我先拟着。",
      aboutYou,
    });
    expect(result.outboundDraft).toBeTruthy();
    expect(result.outboundDraft!.action).toBe("message.draft.send");
    expect(result.outboundDraft!.target).toBe("同事");
    expect(result.outboundDraft!.preview).toMatch(/明天上午.*晚到/);
    expect(result.outboundDraft!.preview).not.toContain("之前提到的那件事");
    expect(result.outboundDraft!.preview).not.toContain("已发送");
    expect(result.diaryFacts).toEqual([]);
  });

describe("@huoye/core applyFieldReplacements", () => {
  it("replaces a full-width colon field and keeps the frontmatter", () => {
    const content = "---\ntitle: 基本档案\nkind: about_you\n---\n\n# 基本档案\n\n- 称呼：\n- 时区：Asia/Shanghai\n";
    const next = applyFieldReplacements(content, [{ field: "称呼", value: "方陈" }]);
    expect(next).toContain("- 称呼：方陈");
    expect(next).toContain("title: 基本档案");
    expect(next).toContain("- 时区：Asia/Shanghai");
  });

  it("appends a missing field at the end of the list", () => {
    const content = "---\ntitle: 生活习惯\n---\n\n# 生活习惯\n\n- 作息：\n";
    const next = applyFieldReplacements(content, [{ field: "饮食偏好", value: "清淡" }]);
    expect(next).toContain("- 饮食偏好：清淡");
    expect(next).toContain("title: 生活习惯");
  });
});

describe("@huoye/core 写一页笔记的意图", () => {
  it("认出「写一页关于 X 的笔记」", async () => {
    const result = await extractMemoryUpdate({
      userText: "写一页关于活页的笔记",
      assistantText: "活页是一个本地优先的个人助手。",
      aboutYou,
    });
    expect(result.note).toBeTruthy();
    expect(result.note!.title).toBe("活页");
    expect(result.note!.body).toContain("本地优先");
    // 笔记已经是落地方式了，不再重复写一条日记。
    expect(result.diaryFacts).toEqual([]);
  });

  it("认出「把刚才的内容记成笔记」并用助手的回复做初稿", async () => {
    const result = await extractMemoryUpdate({
      userText: "把刚才的内容记成笔记",
      assistantText: "我们刚才讨论了报价口径。",
      aboutYou,
    });
    expect(result.note).toBeTruthy();
    expect(result.note!.body).toContain("报价口径");
    expect(result.note!.title).toContain("报价口径");
  });

  it("用户给了正文就用自己的", () => {
    const note = matchNoteIntent("记成笔记：明天去客户那边过一遍方案");
    expect(note).toBeTruthy();
    expect(note!.body).toBe("明天去客户那边过一遍方案");
    expect(note!.title).toBe("");
  });

  it("普通句子不会触发写笔记", async () => {
    const result = await extractMemoryUpdate({
      userText: "我有用记笔记的习惯。",
      assistantText: "嗯。",
      aboutYou,
    });
    expect(result.note).toBeUndefined();
  });

  it("追加核心档案仍然先走确认，不直接改", async () => {
    const result = await extractMemoryUpdate({
      userText: "写一页关于我的笔记，我叫方陈",
      assistantText: "好。",
      aboutYou,
    });
    expect(result.note).toBeTruthy();
    const targets = result.patches.map((patch) => patch.targetPath);
    expect(targets).toContain("about-you/profile.md");
  });
});
