import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  backlinksFor,
  buildBacklinkIndex,
  extractTodos,
  filterByScope,
  isNoteScope,
  listNoteDocuments,
  noteRelativePath,
  noteSlug,
  normalizeTodoLines,
  parseWikiLinks,
  readNote,
  resolveWikiLinks,
  scopeOfPath,
  searchNotes,
  searchNotesInStore,
  splitWikiLinkSegments,
  toggleTodoAt,
  uniqueNotePath,
  writeNote,
  NOTE_SCOPES,
} from "./notes";
import { MemoryConflictError } from "./errors";
import { MemoryStore } from "./store";
import { parseFrontmatter } from "./frontmatter";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/memory-seed",
);

function tempStore(): MemoryStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "huoye-notes-"));
  const store = new MemoryStore({
    memoryRoot: path.join(dir, "memory"),
    seedDir: fixtureRoot,
    timezone: "Asia/Shanghai",
  });
  store.seed();
  return store;
}

function seedDocs() {
  return [
    { path: "notes/读书.md", title: "读书", body: "这周读完了《活着》。", kind: "note" as const, updatedAt: "2026-01-02T00:00:00+08:00" },
    { path: "diaries/2026-01-01.md", title: "2026-01-01 的日记", body: "今天见了老同学。", kind: "diary" as const, updatedAt: "2026-01-01T00:00:00+08:00" },
    { path: "meetings/周会.md", title: "周会", body: "决定了报价口径。", kind: "meeting" as const, updatedAt: "2026-01-03T00:00:00+08:00" },
    { path: "health/2026-01-01.md", title: "2026-01-01 的健康记录", body: "睡眠 7 小时。", kind: "health" as const, updatedAt: "2026-01-01T00:00:00+08:00" },
  ];
}

describe("@huoye/memory notes 范围与检索", () => {
  it("按路径判定笔记类型", () => {
    expect(scopeOfPath("notes/a.md")).toBe("note");
    expect(scopeOfPath("meetings/a.md")).toBe("meeting");
    expect(scopeOfPath("diaries/2026-01-01.md")).toBe("diary");
    expect(scopeOfPath("health/2026-01-01.md")).toBe("health");
    expect(scopeOfPath("uploads/a.md")).toBe("other");
  });

  it("范围取值只有这几个，别的字符串不算范围", () => {
    expect([...NOTE_SCOPES]).toEqual(["all", "diary", "meeting", "note", "health"]);
    expect(isNoteScope("note")).toBe(true);
    expect(isNoteScope("all")).toBe(true);
    expect(isNoteScope("other")).toBe(false);
    expect(isNoteScope("")).toBe(false);
    expect(isNoteScope(undefined)).toBe(false);
  });

  it("按范围过滤文档，all 留全部", () => {
    const docs = seedDocs();
    expect(filterByScope(docs, "all").map((doc) => doc.path)).toEqual(docs.map((doc) => doc.path));
    expect(filterByScope(docs, "diary").map((doc) => doc.path)).toEqual(["diaries/2026-01-01.md"]);
    expect(filterByScope(docs, "note").map((doc) => doc.path)).toEqual(["notes/读书.md"]);
    expect(filterByScope(docs, "meeting").map((doc) => doc.path)).toEqual(["meetings/周会.md"]);
    expect(filterByScope(docs, "health").map((doc) => doc.path)).toEqual(["health/2026-01-01.md"]);
  });

  it("标题和正文都能搜到", () => {
    const docs = seedDocs();
    expect(searchNotes(docs, "读书").map((hit) => hit.path)).toEqual(["notes/读书.md"]);
    expect(searchNotes(docs, "活着").map((hit) => hit.path)).toEqual(["notes/读书.md"]);
    expect(searchNotes(docs, "报价").map((hit) => hit.path)).toEqual(["meetings/周会.md"]);
  });

  it("范围筛选只留下该类文档", () => {
    const docs = seedDocs();
    expect(searchNotes(docs, "", "note").map((hit) => hit.path)).toEqual(["notes/读书.md"]);
    expect(searchNotes(docs, "", "meeting").map((hit) => hit.path)).toEqual(["meetings/周会.md"]);
    expect(searchNotes(docs, "", "diary").map((hit) => hit.path)).toEqual(["diaries/2026-01-01.md"]);
    expect(searchNotes(docs, "", "health").map((hit) => hit.path)).toEqual(["health/2026-01-01.md"]);
    expect(searchNotes(docs, "", "all")).toHaveLength(4);
  });

  it("范围和关键词一起生效", () => {
    const docs = seedDocs();
    expect(searchNotes(docs, "读书", "diary")).toEqual([]);
    expect(searchNotes(docs, "读书", "note")).toHaveLength(1);
  });

  it("换范围后结果不会串到别的类型里", () => {
    const docs = seedDocs();
    docs.push({ path: "notes/周会.md", title: "周会笔记", body: "也在笔记里写了一遍。", kind: "note", updatedAt: "2026-01-05T00:00:00+08:00" });
    const inMeetings = searchNotes(docs, "周会", "meeting");
    expect(inMeetings.map((hit) => hit.path)).toEqual(["meetings/周会.md"]);
    const inNotes = searchNotes(docs, "周会", "note");
    expect(inNotes.map((hit) => hit.path)).toEqual(["notes/周会.md"]);
  });

  it("在工作区里检索会带上真实文件", () => {
    const store = tempStore();
    writeNote(store, {
      path: "notes/买菜.md",
      title: "买菜",
      body: "买了西红柿和鸡蛋。",
      expectedRevision: "",
    });
    const hits = searchNotesInStore(store, "西红柿", "note");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe("notes/买菜.md");
    expect(hits[0]!.title).toBe("买菜");
    const docs = listNoteDocuments(store);
    expect(docs.some((doc) => doc.path === "notes/买菜.md")).toBe(true);
  });
});

describe("@huoye/memory notes 双链", () => {
  it("按标题解析 [[标题]]，解析不到就标出来", () => {
    const docs = seedDocs();
    const links = resolveWikiLinks("见 [[周会]] 和 [[不存在的页面]]。", docs);
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ target: "周会", resolved: true, path: "meetings/周会.md", title: "周会" });
    expect(links[1]).toEqual({ target: "不存在的页面", resolved: false });
  });

  it("抽出正文里的双链", () => {
    expect(parseWikiLinks("[[周会]] 还有 [[读书]]，再来一次 [[周会]]")).toEqual(["周会", "读书"]);
  });

  it("把正文切成文字和双链片段", () => {
    expect(splitWikiLinkSegments("相关：[[读书]] 和 [[还没有的那一页]]。")).toEqual([
      { kind: "text", text: "相关：" },
      { kind: "link", target: "读书" },
      { kind: "text", text: " 和 " },
      { kind: "link", target: "还没有的那一页" },
      { kind: "text", text: "。" },
    ]);
    expect(splitWikiLinkSegments("没有双链")).toEqual([{ kind: "text", text: "没有双链" }]);
    expect(splitWikiLinkSegments("")).toEqual([]);
  });

  it("反向链接找出链到本页的页面", () => {
    const docs = seedDocs();
    docs.push({ path: "notes/计划.md", title: "计划", body: "参考 [[读书]]。", kind: "note", updatedAt: "2026-01-04T00:00:00+08:00" });
    const target = docs.find((doc) => doc.path === "notes/读书.md")!;
    const back = backlinksFor(target, docs);
    expect(back.map((doc) => doc.path)).toEqual(["notes/计划.md"]);
  });

  it("反链索引记下所有链过来的页面，自己链自己不算", () => {
    const docs = seedDocs();
    docs.push({ path: "notes/计划.md", title: "计划", body: "参考 [[读书]]。", kind: "note", updatedAt: "2026-01-04T00:00:00+08:00" });
    docs.push({ path: "notes/读书笔记.md", title: "读书笔记", body: "也在读 [[读书]]，还链了 [[不存在的页面]]。", kind: "note", updatedAt: "2026-01-05T00:00:00+08:00" });
    docs.push({ path: "notes/自链.md", title: "自链", body: "见 [[自链]]", kind: "note", updatedAt: "2026-01-06T00:00:00+08:00" });

    const index = buildBacklinkIndex(docs);
    expect(index.get("notes/读书.md")?.map((doc) => doc.path)).toEqual(["notes/计划.md", "notes/读书笔记.md"]);
    expect(index.get("notes/自链.md")?.map((doc) => doc.path)).toEqual(["notes/自链.md"]);

    const self = docs.find((doc) => doc.path === "notes/自链.md")!;
    expect(backlinksFor(self, docs)).toEqual([]);

    const target = docs.find((doc) => doc.path === "notes/读书.md")!;
    expect(backlinksFor(target, docs).map((doc) => doc.path)).toEqual(["notes/计划.md", "notes/读书笔记.md"]);
  });
});

describe("@huoye/memory notes 待办", () => {
  it("行首的 [ ] 规范成 - [ ]", () => {
    expect(normalizeTodoLines("[ ] 买牛奶")).toBe("- [ ] 买牛奶");
    expect(normalizeTodoLines("[x] 买牛奶")).toBe("- [x] 买牛奶");
    expect(normalizeTodoLines("[X] 买牛奶")).toBe("- [x] 买牛奶");
    expect(normalizeTodoLines("- [ ] 买牛奶")).toBe("- [ ] 买牛奶");
    expect(normalizeTodoLines("- [X] 买牛奶")).toBe("- [x] 买牛奶");
    expect(normalizeTodoLines("这句话里有 [ ] 括号")).toBe("这句话里有 [ ] 括号");
  });

  it("抽出待办并能勾选回去", () => {
    const body = "- [ ] 买牛奶\n- [x] 寄快递\n普通文字";
    const todos = extractTodos(body);
    expect(todos).toEqual([
      { index: 0, done: false, text: "买牛奶" },
      { index: 1, done: true, text: "寄快递" },
    ]);
    expect(toggleTodoAt(body, 0)).toContain("- [x] 买牛奶");
    expect(toggleTodoAt(body, 1)).toContain("- [ ] 寄快递");
  });

  it("裸写的 [ ] 和 [x] 也算待办", () => {
    const todos = extractTodos("[ ] 买牛奶\n[x] 寄快递\n- [ ] 交房租");
    expect(todos).toEqual([
      { index: 0, done: false, text: "买牛奶" },
      { index: 1, done: true, text: "寄快递" },
      { index: 2, done: false, text: "交房租" },
    ]);
  });

  it("有序列表的待办也认得，勾选后保留原来的列表符号", () => {
    const body = "1. [ ] 买牛奶\n2. [x] 寄快递";
    expect(extractTodos(body)).toEqual([
      { index: 0, done: false, text: "买牛奶" },
      { index: 1, done: true, text: "寄快递" },
    ]);
    expect(toggleTodoAt(body, 0)).toContain("1. [x] 买牛奶");
    expect(toggleTodoAt(body, 1)).toContain("2. [ ] 寄快递");
  });

  it("勾选只动第 index 条，其它行不动", () => {
    const body = "- [ ] 一个\n- [ ] 两个\n- [x] 三个";
    expect(toggleTodoAt(body, 1)).toBe("- [ ] 一个\n- [x] 两个\n- [x] 三个");
    expect(toggleTodoAt(body, 9)).toBe(body);
  });
});

describe("@huoye/memory notes 读写", () => {
  it("标题转成安全的文件名", () => {
    expect(noteSlug("关于 活页 的 想法")).toBe("关于-活页-的-想法");
    expect(noteRelativePath("周报")).toBe("notes/周报.md");
    expect(noteRelativePath("周报", "meetings")).toBe("meetings/周报.md");
  });

  it("同名文件不覆盖", () => {
    const store = tempStore();
    const first = uniqueNotePath(store, "周报");
    writeNote(store, { path: first, title: "周报", body: "第一版", expectedRevision: "" });
    const second = uniqueNotePath(store, "周报");
    expect(second).not.toBe(first);
    expect(existsSync(path.join(store.memoryRoot, second))).toBe(false);
  });

  it("YAML 头不进正文，保存时重新合成", () => {
    const store = tempStore();
    const saved = writeNote(store, {
      path: "notes/买菜.md",
      title: "买菜",
      body: "买了西红柿。",
      expectedRevision: "",
      date: "2026-01-05",
    });
    const raw = saved.content;
    expect(raw.startsWith("---")).toBe(true);
    expect(raw).toContain("kind: note");
    expect(raw).toContain("title: 买菜");
    expect(raw).toContain("date: 2026-01-05");
    expect(raw).toContain("买了西红柿。");

    const detail = readNote(store, "notes/买菜.md");
    expect(detail.body.trim()).toBe("买了西红柿。");
    expect(detail.body).not.toContain("kind: note");
    expect(detail.frontmatter.title).toBe("买菜");
    expect(detail.revision).toBe(saved.revision);
  });

  it("版本对不上时报冲突，不会覆盖", () => {
    const store = tempStore();
    const saved = writeNote(store, { path: "notes/买菜.md", title: "买菜", body: "第一版", expectedRevision: "" });
    writeFileSync(path.join(store.memoryRoot, "notes/买菜.md"), `${saved.content}\n别人写的。\n`, "utf8");
    expect(() =>
      writeNote(store, { path: "notes/买菜.md", title: "买菜", body: "我的版本", expectedRevision: saved.revision }),
    ).toThrowError(MemoryConflictError);
    const after = parseFrontmatter(readFileSync(path.join(store.memoryRoot, "notes/买菜.md"), "utf8"));
    expect(after.body).toContain("别人写的。");
  });

  it("只允许保存 notes/ 和 meetings/ 里的文件", () => {
    const store = tempStore();
    expect(() =>
      writeNote(store, { path: "about-you/profile.md", title: "档案", body: "x", expectedRevision: "" }),
    ).toThrowError(/只能保存笔记和会议纪要/);
  });
});
