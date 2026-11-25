import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MemoryConflictError,
  MemoryPathError,
  MemoryPermissionError,
  MemoryStore,
  healthCardSummary,
  healthRelativePath,
  normalizeRelative,
  parseFrontmatter,
  recordingRelativePath,
  summarizeHealthNote,
  bodyWithProvenance,
  humanMemoryBody,
  visibleMemoryBody,
  zipMemoryTree,
} from "./index";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/memory-seed",
);

function tempStore(): MemoryStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "huoye-memory-"));
  const store = new MemoryStore({
    memoryRoot: path.join(dir, "memory"),
    seedDir: fixtureRoot,
    timezone: "Asia/Shanghai",
  });
  store.seed();
  return store;
}

describe("@huoye/memory", () => {
  it("creates the seed tree with five core files", () => {
    const store = tempStore();
    const tree = store.listTree();
    const about = tree.find((n) => n.name === "about-you");
    expect(about?.type).toBe("dir");
    const names = (about?.children ?? []).map((c) => c.name).sort();
    expect(names).toEqual([
      "devices.md",
      "identity.md",
      "lifestyle.md",
      "profile.md",
      "work.md",
    ]);
    for (const dir of ["diaries", "uploads", "health", "recordings", "activities"]) {
      expect(tree.some((n) => n.name === dir && n.type === "dir")).toBe(true);
    }
    const profile = store.readFile("about-you/profile.md");
    expect(profile.kind).toBe("about_you");
    expect(profile.content).toContain("基本档案");
  });

  it("composes ABOUT.md in the fixed about-you order and skips empty files", () => {
    const store = tempStore();
    const extra = path.join(store.memoryRoot, "about-you", "zz-notes.md");
    writeFileSync(
      extra,
      "---\ntitle: 补充\nkind: about_you\n---\n\n# 补充\n\n一则额外说明。\n",
      "utf8",
    );
    const { markdown, files } = store.composeAboutYou();
    const titles = files.map((f) => f.relativePath);
    expect(titles[0]).toBe("about-you/profile.md");
    expect(titles[1]).toBe("about-you/identity.md");
    expect(titles[2]).toBe("about-you/lifestyle.md");
    expect(titles[3]).toBe("about-you/work.md");
    expect(titles[4]).toBe("about-you/devices.md");
    expect(titles[5]).toBe("about-you/zz-notes.md");
    expect(markdown.indexOf("基本档案")).toBeLessThan(markdown.indexOf("自我认同"));
    expect(markdown.indexOf("自我认同")).toBeLessThan(markdown.indexOf("生活习惯"));
    expect(markdown.indexOf("生活习惯")).toBeLessThan(markdown.indexOf("工作与项目"));
    expect(markdown.indexOf("工作与项目")).toBeLessThan(markdown.indexOf("设备与工具"));
    expect(markdown.indexOf("设备与工具")).toBeLessThan(markdown.indexOf("补充"));
    expect(markdown).toContain("请改源文件");
    const visible = markdown.replace(/<!--[\s\S]*?-->/g, "").trim();
    expect(visible).not.toContain("由活页根据");
    expect(visible).not.toContain("请改源文件");
    expect((visible.match(/^#+\s*基本档案\s*$/gm) ?? []).length).toBe(1);
    expect(visible).toContain("## 基本档案");
    expect(visible).not.toMatch(/^# 基本档案/m);
    const about = store.regenerateAboutMd();
    expect(about.readonly).toBe(true);
    expect(about.kind).toBe("system_summary");
  });

  it("rejects path traversal and absolute paths", () => {
    expect(() => normalizeRelative("../secrets.json")).toThrow(MemoryPathError);
    expect(() => normalizeRelative("about-you/../../etc/passwd")).toThrow(MemoryPathError);
    expect(() => normalizeRelative("/etc/passwd")).toThrow(MemoryPathError);
    expect(() => normalizeRelative("about-you/./profile.md")).toThrow(MemoryPathError);
    const store = tempStore();
    expect(() => store.readFile("../config.json")).toThrow(MemoryPathError);
  });

  it("conflicts when expectedRevision does not match the disk file", () => {
    const store = tempStore();
    const file = store.readFile("about-you/profile.md");
    writeFileSync(path.join(store.memoryRoot, "about-you/profile.md"), `${file.content}\n被外部改过。\n`, "utf8");
    expect(() => store.writeFile("about-you/profile.md", `${file.content}\n我的草稿。\n`, file.revision)).toThrow(
      MemoryConflictError,
    );
    const latest = store.readFile("about-you/profile.md");
    const saved = store.writeFile("about-you/profile.md", `${latest.content}\n手改一行。\n`, latest.revision);
    expect(saved.content).toContain("手改一行");
    expect(saved.revision).not.toBe(latest.revision);
  });

  it("refuses to delete or rename the five core about-you files", () => {
    const store = tempStore();
    for (const file of [
      "about-you/profile.md",
      "about-you/identity.md",
      "about-you/lifestyle.md",
      "about-you/work.md",
      "about-you/devices.md",
    ]) {
      expect(() => store.deleteFile(file)).toThrow(MemoryPermissionError);
      expect(() => store.rename(file, "about-you/renamed.md")).toThrow(MemoryPermissionError);
    }
    // 只允许清空正文，文件仍在
    const profile = store.readFile("about-you/profile.md");
    store.writeFile("about-you/profile.md", "---\ntitle: 基本档案\nkind: about_you\n---\n\n", profile.revision);
    expect(store.readFile("about-you/profile.md").relativePath).toBe("about-you/profile.md");
  });

  it("appends a diary entry with provenance and creates the day file if needed", () => {
    const store = tempStore();
    const file = store.appendDiary({
      date: "2026-11-23",
      fact: "想在本地先把记忆树跑通",
      sourceLabel: "来自聊天",
      sourceRef: "chat:cht_demo / turn:t_001",
      actor: "agent",
    });
    expect(file.relativePath).toBe("diaries/2026-11-23.md");
    expect(file.kind).toBe("diary");
    expect(file.content).toContain("想在本地先把记忆树跑通");
    expect(file.content).toContain("出处：chat:cht_demo / turn:t_001");
    expect(file.content).toMatch(/## \d{2}:\d{2} · 来自聊天/);
    const again = store.appendDiary({
      date: "2026-11-23",
      fact: "又记了一笔",
      sourceRef: "chat:cht_demo / turn:t_002",
    });
    expect(again.content).toContain("又记了一笔");
    expect(again.content).toContain("想在本地先把记忆树跑通");
  });

  it("searches with the MemorySearchHit shape", () => {
    const store = tempStore();
    const hits = store.search("工作与项目");
    expect(hits.some((h) => h.path === "about-you/work.md")).toBe(true);
    expect(hits[0]).toEqual(
      expect.objectContaining({
        path: expect.any(String),
        title: expect.any(String),
        snippet: expect.any(String),
        score: expect.any(Number),
      }),
    );
  });

  it("exports a zip that contains about-you/profile.md", async () => {
    const store = tempStore();
    const buf = await zipMemoryTree(store.memoryRoot);
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file("about-you/profile.md");
    expect(entry).toBeTruthy();
    const text = await entry!.async("string");
    expect(text).toContain("基本档案");
  });

  it("records activities for writes", () => {
    const store = tempStore();
    const file = store.readFile("about-you/work.md");
    store.writeFile("about-you/work.md", `${file.content}\n新增一行。\n`, file.revision);
    const { items } = store.listActivities(20);
    expect(items.some((a) => a.path === "about-you/work.md" && a.op === "update")).toBe(true);
    expect(items[0]?.cursor).toBeTruthy();
  });

  it("rejects a bogus expectedRevision when creating a new file", () => {
    const store = tempStore();
    const pathName = "about-you/new-note.md";
    expect(() => store.writeFile(pathName, "# 新笔记\n\n内容\n", "deadbeef")).toThrow(MemoryConflictError);
    expect(() => store.readFile(pathName)).toThrow();
    const created = store.writeFile(pathName, "---\ntitle: 新笔记\nkind: about_you\n---\n\n# 新笔记\n\n内容\n", "");
    expect(created.relativePath).toBe(pathName);
    expect(created.content).toContain("内容");
  });

  it("records create (not update) when writing a new file", () => {
    const store = tempStore();
    store.writeFile("about-you/fresh.md", "---\ntitle: 新建\nkind: about_you\n---\n\n一段新内容。\n", "");
    const { items } = store.listActivities(20);
    const created = items.find((a) => a.path === "about-you/fresh.md");
    expect(created?.op).toBe("create");
  });

  it("lists diaries and about-you as folders", () => {
    const store = tempStore();
    const diaries = store.listFolder("diaries");
    expect(diaries.type).toBe("dir");
    expect(diaries.name).toBe("diaries");
    expect(diaries.children).toEqual([]);
    const about = store.listFolder("about-you");
    expect(about.type).toBe("dir");
    expect(about.children?.some((c) => c.name === "profile.md")).toBe(true);
  });

  it("writes the display name into profile.md 称呼", () => {
    const store = tempStore();
    const saved = store.setProfileDisplayName("方陈");
    expect(saved?.content).toMatch(/^- 称呼：方陈$/m);
    expect(store.readFile("about-you/profile.md").content).toMatch(/^- 称呼：方陈$/m);
  });

  it("writes and reads a dated health note with provenance, and keeps it editable", () => {
    const store = tempStore();
    expect(store.readHealthNote("2026-11-23")).toBeNull();
    const file = store.appendHealthNote({
      date: "2026-11-23",
      sleep: "大约睡了 7 小时",
      movement: "走了半小时",
      mood: "平静",
      sourceRef: "health:hand",
      actor: "owner",
    });
    expect(file.relativePath).toBe("health/2026-11-23.md");
    expect(healthRelativePath("2026-11-23")).toBe("health/2026-11-23.md");
    expect(file.kind).toBe("other");
    expect(file.readonly).toBe(false);
    expect(file.content).toContain("睡眠：大约睡了 7 小时");
    expect(file.content).toContain("活动：走了半小时");
    expect(file.content).toContain("出处：health:hand");
    const again = store.appendHealthNote({
      date: "2026-11-23",
      note: "下午有点困",
    });
    expect(again.content).toContain("下午有点困");
    expect(again.content).toContain("大约睡了 7 小时");
    expect(healthCardSummary(again.content)).toBe("下午有点困");
    expect(healthCardSummary(again.content)).not.toContain("大约睡了 7 小时");
    const edited = store.writeFile(again.relativePath, `${again.content}
补记：多喝水。
`, again.revision);
    expect(edited.content).toContain("补记：多喝水");
    expect(store.listHealthNotes().some((item) => item.relativePath === "health/2026-11-23.md")).toBe(true);
    expect(summarizeHealthNote(file.content)).toEqual(["睡眠：大约睡了 7 小时", "活动：走了半小时", "心情：平静"]);
    expect(healthCardSummary(file.content)).toContain("大约睡了 7 小时");
    expect(() => store.appendHealthNote({ date: "2026-11-23" })).toThrow(MemoryPathError);
  });

  it("writes a recording note that stays editable", () => {
    const store = tempStore();
    const id = "rec_testdemo";
    const file = store.writeRecordingNote({
      id,
      originalName: "desk.wav",
      body: "还没有配置可用的语音转写。音频已经保存在本机，你可以在这里补记这段录音的内容。\n\n- 出处：recording:rec_testdemo\n",
      status: "failed",
      error: "还没有配置可用的语音转写",
      source: "upload",
      audioExt: "wav",
    });
    expect(file.relativePath).toBe(recordingRelativePath(id));
    expect(file.kind).toBe("other");
    expect(file.readonly).toBe(false);
    expect(file.content).toContain("还没有配置可用的语音转写");
    expect(file.content).toContain("出处：recording:rec_testdemo");
    const latest = store.readRecordingNote(id);
    expect(latest?.title).toBe("desk");
    const saved = store.writeFile(file.relativePath, `${file.content}\n补记：桌边的一段谈话。\n`, file.revision);
    expect(saved.content).toContain("桌边的一段谈话");
  });

  it("keeps createdAt in local timezone form when appending another health note", () => {
    const store = tempStore();
    const first = store.appendHealthNote({
      date: "2026-11-23",
      sleep: "大约睡了 7 小时",
      actor: "owner",
    });
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    const again = store.appendHealthNote({
      date: "2026-11-23",
      note: "QA标记：health-ui-1",
    });
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.createdAt).not.toMatch(/Z$/);
    const raw = readFileSync(path.join(store.memoryRoot, "health/2026-11-23.md"), "utf8");
    expect(raw).toMatch(/createdAt: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    expect(raw).not.toMatch(/createdAt: .*Z/);
    const parsed = parseFrontmatter(raw);
    expect(parsed.frontmatter.createdAt).toBe(first.createdAt);
  });

  it("lets writeBrief overwrite an existing brief while users still cannot edit it", () => {
    const store = tempStore();
    const first = store.writeBrief({
      date: "2026-11-23",
      slot: "morning",
      text: "第一版。",
      generatedAt: "2026-11-23T13:41:03+08:00",
      source: "local",
      label: "午间",
    });
    expect(first.readonly).toBe(true);
    expect(() => store.writeFile(first.relativePath, "用户改简报", first.revision, "owner")).toThrow(
      MemoryPermissionError,
    );
    const second = store.writeBrief({
      date: "2026-11-23",
      slot: "morning",
      text: "第二版，补上了今天的健康记录。",
      generatedAt: "2026-11-23T13:50:00+08:00",
      source: "local",
      label: "午间",
    });
    expect(second.content).toContain("第二版，补上了今天的健康记录。");
    expect(second.content).not.toContain("第一版。");
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("summarizes a health file with YAML frontmatter and multiple appends without leaking keys", () => {
    const raw = `---
id: mem_01m83er3r4w70vvzz99p47yjqq
title: 2026-11-23 的健康记录
kind: other
pinned: false
readonly: false
createdAt: 2026-11-23T13:41:03+08:00
updatedAt: 2026-11-23T13:43:23+08:00
---

## 13:41 · 手记

- 睡眠：大约睡了 7 小时
- 活动：走了半小时
- 心情：平静
- 出处：health:hand

## 13:43 · 手记

- 睡眠：大约睡了 6 小时
- 活动：下午散步 20 分钟
- 心情：还好
- 备注：QA标记：health-ui-1
- 出处：health:hand
`;
    expect(summarizeHealthNote(raw)).toEqual([
      "睡眠：大约睡了 7 小时",
      "活动：走了半小时",
      "心情：平静",
      "睡眠：大约睡了 6 小时",
      "活动：下午散步 20 分钟",
      "心情：还好",
      "备注：QA标记：health-ui-1",
    ]);
    const visible = visibleMemoryBody(raw);
    expect(visible).toContain("下午散步 20 分钟");
    expect(visible).not.toContain("id:");
    expect(visible).not.toContain("createdAt:");
    expect(visible.trimStart().startsWith("---")).toBe(false);
    expect(healthCardSummary(raw)).toContain("大约睡了 6 小时");
    expect(healthCardSummary(raw)).toContain("下午散步 20 分钟");
    expect(healthCardSummary(raw)).toContain("QA标记：health-ui-1");
    expect(healthCardSummary(raw)).not.toContain("7 小时");
    expect(healthCardSummary(raw)).not.toContain("走了半小时");
    expect(healthCardSummary(raw)).not.toContain("kind:");
    expect(humanMemoryBody(raw)).toContain("下午散步 20 分钟");
    expect(humanMemoryBody(raw)).toContain("大约睡了 7 小时");
    expect(humanMemoryBody(raw)).not.toContain("出处：");
    const saved = bodyWithProvenance(humanMemoryBody(raw) + "\n补记：再看一眼。\n", raw);
    expect(saved).toContain("补记：再看一眼。");
    expect(saved).toContain("出处：health:hand");
    expect(humanMemoryBody(saved)).not.toContain("出处：");
  });

});
