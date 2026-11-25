/**
 * 日常笔记、会议纪要，以及记忆页的检索与双链。
 *
 * 数据仍然是一堆 Markdown 文件加 YAML 头：
 * - notes/<slug>.md      日常笔记，普通可编辑
 * - meetings/<slug>.md   会议纪要，普通可编辑
 *
 * YAML 头只存在于文件里，绝不进入可编辑正文；读写都走 frontmatter.ts 的解析与合成。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ID_PREFIXES, nowIso, type MemoryFile, type Provenance } from "@huoye/schema";
import { MemoryConflictError, MemoryNotFoundError, MemoryPathError, MemoryPermissionError } from "./errors";
import { inferTitle, parseFrontmatter, snippetOf, stringifyFrontmatter } from "./frontmatter";
import { newId } from "./ids";
import { resolveSafe } from "./paths";
import { revisionFor } from "./revision";
import type { MemoryStore } from "./store";

export const NOTES_DIR = "notes";
export const MEETINGS_DIR = "meetings";

/** 记忆页的范围筛选。 */
export type NoteScope = "all" | "diary" | "meeting" | "note" | "health";

/** 单个范围对应的文件类型。 */
export type NoteKind = "diary" | "meeting" | "note" | "health" | "other";

/** 记忆页可选的全部范围，顺序就是界面上的顺序。 */
export const NOTE_SCOPES: readonly NoteScope[] = ["all", "diary", "meeting", "note", "health"];

/** 判断一个字符串是不是合法的检索范围。 */
export function isNoteScope(value: unknown): value is NoteScope {
  return typeof value === "string" && (NOTE_SCOPES as readonly string[]).includes(value);
}

export interface NoteDocument {
  path: string;
  title: string;
  /** 可编辑正文，不含 YAML 头。 */
  body: string;
  kind: NoteKind;
  updatedAt: string;
}

export interface NoteSearchHit {
  path: string;
  title: string;
  kind: NoteKind;
  snippet: string;
  score: number;
  updatedAt: string;
}

export interface WikiLink {
  /** `[[标题]]` 里写的标题。 */
  target: string;
  resolved: boolean;
  path?: string;
  title?: string;
}

export interface TodoItem {
  /** 在正文里的顺序，从 0 开始。 */
  index: number;
  done: boolean;
  text: string;
}

/** 系统生成的摘要与日志不参与笔记检索。 */
const EXCLUDED_PREFIXES = ["briefs/", "activities/"];

export function scopeOfPath(relativePath: string): NoteKind {
  const p = (relativePath ?? "").replace(/\\/g, "/");
  if (p.startsWith("diaries/")) return "diary";
  if (p.startsWith(`${MEETINGS_DIR}/`)) return "meeting";
  if (p.startsWith(`${NOTES_DIR}/`)) return "note";
  if (p.startsWith("health/")) return "health";
  return "other";
}

function isSearchable(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, "/");
  if (p === "ABOUT.md") return false;
  if (EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix))) return false;
  return p.endsWith(".md");
}

/** 把工作区里可读的 Markdown 收成一份文档清单，YAML 头已经剥掉。 */
export function listNoteDocuments(store: MemoryStore): NoteDocument[] {
  const docs: NoteDocument[] = [];
  const walk = (nodes: ReturnType<MemoryStore["listTree"]>) => {
    for (const node of nodes) {
      if (node.type === "dir") {
        if (node.relativePath === ".git") continue;
        walk(node.children ?? []);
        continue;
      }
      if (!isSearchable(node.relativePath)) continue;
      let file: MemoryFile;
      try {
        file = store.readFile(node.relativePath);
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(file.content);
      docs.push({
        path: file.relativePath,
        title: inferTitle(file.relativePath, parsed.frontmatter, parsed.body),
        body: parsed.body,
        kind: scopeOfPath(file.relativePath),
        updatedAt: file.updatedAt,
      });
    }
  };
  walk(store.listTree());
  return docs;
}

/**
 * 记忆页全文检索：标题和正文都搜，范围先过滤。
 * query 为空时返回该范围下的全部文档。
 */
export function searchNotes(
  docs: NoteDocument[],
  query: string,
  scope: NoteScope = "all",
): NoteSearchHit[] {
  const q = (query ?? "").trim();
  const inScope = filterByScope(docs, scope);
  if (!q) {
    return inScope
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path))
      .map((doc) => ({
        path: doc.path,
        title: doc.title,
        kind: doc.kind,
        snippet: snippetOf(doc.body, 120),
        score: 0,
        updatedAt: doc.updatedAt,
      }));
  }

  const lower = q.toLowerCase();
  const hits: NoteSearchHit[] = [];
  for (const doc of inScope) {
    const hay = `${doc.title}\n${doc.body}`;
    const index = hay.toLowerCase().indexOf(lower);
    if (index < 0) continue;
    const start = Math.max(0, index - 40);
    hits.push({
      path: doc.path,
      title: doc.title,
      kind: doc.kind,
      snippet: snippetOf(hay.slice(start, start + 160)),
      score: doc.title.toLowerCase().includes(lower) ? 2 : 1,
      updatedAt: doc.updatedAt,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path));
  return hits;
}

/** 按范围挑文档：all 是全部，其余按文件类型挑。 */
export function filterByScope(docs: NoteDocument[], scope: NoteScope = "all"): NoteDocument[] {
  if (scope === "all") return docs.slice();
  return docs.filter((doc) => doc.kind === scope);
}

/** 直接在工作区里检索，省掉调用方自己收文档清单。 */
export function searchNotesInStore(
  store: MemoryStore,
  query: string,
  scope: NoteScope = "all",
): NoteSearchHit[] {
  return searchNotes(listNoteDocuments(store), query, scope);
}

const WIKI_LINK = /\[\[([^[\]\n]+)\]\]/g;

/** 抽出正文里的 `[[标题]]`，按出现顺序去重。 */
export function parseWikiLinks(body: string): string[] {
  const out: string[] = [];
  const text = body ?? "";
  for (const match of text.matchAll(WIKI_LINK)) {
    const target = (match[1] ?? "").trim();
    if (!target) continue;
    if (out.includes(target)) continue;
    out.push(target);
  }
  return out;
}

/** 一段正文里的片段：普通文字，或者一个 `[[双链]]`。 */
export type NoteSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; target: string };

/**
 * 把一段文字切成普通文字和 `[[双链]]` 交替的片段，
 * 这样渲染时双链可以单独做成可点的链接。
 */
export function splitWikiLinkSegments(text: string): NoteSegment[] {
  const source = text ?? "";
  const out: NoteSegment[] = [];
  let last = 0;
  for (const match of source.matchAll(WIKI_LINK)) {
    const target = (match[1] ?? "").trim();
    const start = match.index ?? 0;
    if (start > last) out.push({ kind: "text", text: source.slice(last, start) });
    if (target) out.push({ kind: "link", target });
    last = start + match[0].length;
  }
  if (last < source.length) out.push({ kind: "text", text: source.slice(last) });
  return out;
}

/** 按标题把 `[[标题]]` 解析到已存在的笔记、日记或纪要；解析不到就诚实标出来。 */
export function resolveWikiLinks(body: string, docs: NoteDocument[]): WikiLink[] {
  const targets = parseWikiLinks(body);
  return targets.map((target) => {
    const hit = findByTitle(target, docs);
    if (!hit) return { target, resolved: false };
    return { target, resolved: true, path: hit.path, title: hit.title };
  });
}

function findByTitle(target: string, docs: NoteDocument[]): NoteDocument | undefined {
  const key = target.trim();
  const exact = docs.find((doc) => doc.title.trim() === key);
  if (exact) return exact;
  const base = key.replace(/\.md$/i, "");
  const byPath = docs.find((doc) => doc.path.replace(/\.md$/i, "") === base);
  if (byPath) return byPath;
  const name = base.split("/").pop() ?? base;
  return docs.find((doc) => doc.path.replace(/\.md$/i, "").split("/").pop() === name);
}

/**
 * 反向链接索引：被链接页面的路径 → 链到它的页面。
 * 一次算完，记忆页和笔记编辑器都能直接用。
 */
export function buildBacklinkIndex(docs: NoteDocument[]): Map<string, NoteDocument[]> {
  const index = new Map<string, NoteDocument[]>();
  for (const other of docs) {
    for (const link of resolveWikiLinks(other.body, docs)) {
      if (!link.resolved || !link.path) continue;
      const list = index.get(link.path);
      if (list) list.push(other);
      else index.set(link.path, [other]);
    }
  }
  return index;
}

/** 反向链接：哪些页面链到了这一页。自己链自己不算。 */
export function backlinksFor(doc: NoteDocument, docs: NoteDocument[]): NoteDocument[] {
  const index = buildBacklinkIndex(docs);
  return (index.get(doc.path) ?? []).filter((item) => item.path !== doc.path);
}

/**
 * 待办行：`- [ ] 文字`、`* [x] 文字`、`1. [ ] 文字`，以及行首裸写的 `[ ] 文字`。
 * 行中间的方括号不当待办。
 */
const TODO_LINE = /^(\s*)(?:([-*]|\d+\.)\s+)?\[([ xX])\]\s*(.*)$/;

/** 行首裸写的待办：`[ ] 文字`。 */
const BARE_TODO_LINE = /^(\s*)\[([ xX])\]\s*(.*)$/;

/**
 * 把行首的 `[ ] `、`[x] ` 规范成 `- [ ] `、`- [x] `。
 * 已经规范的行只统一 X 的大小写，句子中间的方括号也不动。
 */
export function normalizeTodoLines(text: string): string {
  return (text ?? "")
    .split("\n")
    .map((line) => {
      const bare = line.match(BARE_TODO_LINE);
      if (bare) {
        const mark = bare[2]!.toLowerCase() === "x" ? "x" : " ";
        return `${bare[1]}- [${mark}] ${bare[3] ?? ""}`.trimEnd();
      }
      const listed = line.match(TODO_LINE);
      if (listed && listed[2]) {
        const mark = listed[3]!.toLowerCase() === "x" ? "x" : " ";
        return `${listed[1]}${listed[2]} [${mark}] ${listed[4] ?? ""}`.trimEnd();
      }
      return line;
    })
    .join("\n");
}

/** 抽出正文里的待办，顺序与正文一致。 */
export function extractTodos(body: string): TodoItem[] {
  const out: TodoItem[] = [];
  for (const line of (body ?? "").split("\n")) {
    const match = line.match(TODO_LINE);
    if (!match) continue;
    out.push({
      index: out.length,
      done: match[3]!.toLowerCase() === "x",
      text: match[4] ?? "",
    });
  }
  return out;
}

/** 勾选第 index 条待办，返回新的正文；行首的列表符号原样保留。 */
export function toggleTodoAt(body: string, index: number): string {
  let seen = -1;
  return (body ?? "")
    .split("\n")
    .map((line) => {
      const match = line.match(TODO_LINE);
      if (!match) return line;
      seen += 1;
      if (seen !== index) return line;
      const mark = match[3]!.toLowerCase() === "x" ? " " : "x";
      const marker = match[2] ? `${match[2]} ` : "";
      return `${match[1]}${marker}[${mark}] ${match[4] ?? ""}`.trimEnd();
    })
    .join("\n");
}

/** 标题转成文件名片段，保留中文。 */
export function noteSlug(title: string): string {
  const base = (title ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!base) return "";
  return base.slice(0, 60);
}

/** 笔记文件相对路径。 */
export function noteRelativePath(title: string, dir: string = NOTES_DIR): string {
  const slug = noteSlug(title);
  if (!slug) throw new MemoryPathError("标题不能是空的");
  return `${dir}/${slug}.md`;
}

/** 同名文件不覆盖，自动加序号。 */
export function uniqueNotePath(store: MemoryStore, title: string, dir: string = NOTES_DIR): string {
  const base = noteRelativePath(title, dir);
  if (!existsSync(path.join(store.memoryRoot, base))) return base;
  const stem = base.replace(/\.md$/i, "");
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${stem}-${i}.md`;
    if (!existsSync(path.join(store.memoryRoot, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}.md`;
}

export interface NoteDetail {
  file: MemoryFile;
  /** 可编辑正文，不含 YAML 头。 */
  body: string;
  frontmatter: Record<string, unknown>;
  revision: string;
}

/** 读一篇笔记，YAML 头和正文分开返回。 */
export function readNote(store: MemoryStore, relativePath: string): NoteDetail {
  const { absolute, relative } = resolveSafe(store.memoryRoot, relativePath);
  if (!existsSync(absolute)) throw new MemoryNotFoundError(`找不到笔记：${relative}`);
  const file = store.readFile(relative);
  const parsed = parseFrontmatter(file.content);
  return {
    file,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
    revision: file.revision,
  };
}

export interface WriteNoteInput {
  path: string;
  title: string;
  /** 可编辑正文，YAML 头由这里重新合成。 */
  body: string;
  /** 保存时必须带的版本号；新建时传空字符串。 */
  expectedRevision: string;
  kind?: "note" | "meeting";
  date?: string;
  actor?: Provenance;
  extra?: Record<string, unknown>;
}

/**
 * 保存一篇笔记或纪要。
 * 保留 YAML 头、正文只放可编辑部分；版本对不上时直接报冲突，不会覆盖别人的改动。
 */
export function writeNote(store: MemoryStore, input: WriteNoteInput): MemoryFile {
  const { absolute, relative } = resolveSafe(store.memoryRoot, input.path);
  const top = relative.split("/")[0] ?? "";
  if (top !== NOTES_DIR && top !== MEETINGS_DIR) {
    throw new MemoryPermissionError("这里只能保存笔记和会议纪要");
  }
  const timezone = store.timezone;
  const existed = existsSync(absolute);
  let frontmatter: Record<string, unknown> = {};
  if (existed) {
    const raw = readFileSync(absolute, "utf8");
    const currentRevision = revisionFor(absolute, raw);
    if (currentRevision !== input.expectedRevision) {
      throw new MemoryConflictError(
        "文件在保存前已被修改",
        { revision: currentRevision, snippet: snippetOf(raw), content: raw },
        { expectedRevision: input.expectedRevision, snippet: snippetOf(input.body), content: input.body },
      );
    }
    frontmatter = { ...parseFrontmatter(raw).frontmatter };
  } else if (input.expectedRevision !== "") {
    throw new MemoryConflictError(
      "创建新文件时 expectedRevision 必须为空字符串",
      { revision: "", snippet: "", content: "" },
      { expectedRevision: input.expectedRevision, snippet: snippetOf(input.body), content: input.body },
    );
  }

  const title = input.title.trim() || inferTitle(input.path, frontmatter, input.body);
  const now = nowIso(timezone);
  const next: Record<string, unknown> = {
    ...frontmatter,
    ...input.extra,
    id: typeof frontmatter.id === "string" && frontmatter.id ? frontmatter.id : newId(ID_PREFIXES.memory),
    title,
    kind: input.kind ?? "note",
    date: input.date ?? (typeof frontmatter.date === "string" ? frontmatter.date : undefined),
    pinned: frontmatter.pinned === true,
    readonly: false,
    createdAt: typeof frontmatter.createdAt === "string" ? frontmatter.createdAt : now,
    updatedAt: now,
  };
  if (next.date === undefined) delete next.date;

  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, stringifyFrontmatter(next, input.body), "utf8");
  const saved = store.readFile(relative);
  store.recordActivity({
    actor: input.actor ?? "owner",
    op: existed ? "update" : "create",
    path: relative,
    revision: saved.revision,
    message: `${existed ? "保存" : "新建"}${relative}`,
  });
  return saved;
}
