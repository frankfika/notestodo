/**
 * 笔记与记忆检索的服务端逻辑。
 *
 * 正文和 YAML 头分开：编辑器只拿到正文，保存时由这里重新合成 YAML 头。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  MEETINGS_DIR,
  NOTES_DIR,
  backlinksFor,
  listNoteDocuments,
  readNote,
  resolveWikiLinks,
  searchNotes,
  uniqueNotePath,
  writeNote,
  type NoteDocument,
  type NoteKind,
  type NoteScope,
  type WikiLink,
} from "@huoye/memory";
import { type MemoryFile } from "@huoye/schema";
import { dateInZone } from "./helpers";
import type { Workspace } from "./workspace";

/** 记忆页的目录先建好，空文件夹也能打开。 */
export function ensureNoteDirs(workspace: Workspace): void {
  for (const dir of [NOTES_DIR, MEETINGS_DIR]) {
    mkdirSync(path.join(workspace.paths.memory, dir), { recursive: true });
  }
}

export interface NoteItem {
  path: string;
  title: string;
  kind: NoteKind;
  snippet: string;
  score: number;
  updatedAt: string;
  href: string;
}

export interface NoteListPayload {
  scope: NoteScope;
  query: string;
  total: number;
  items: NoteItem[];
}

/** 记忆相对路径对应的前端路由。 */
export function memoryHrefFor(relativePath: string): string {
  const posix = (relativePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const diary = posix.match(/^diaries\/([^/]+)$/i);
  if (diary) return `/memories/diaries/${diary[1]!.replace(/\.md$/i, "")}`;
  const health = posix.match(/^health\/([^/]+)$/i);
  if (health) return `/memories/health/${health[1]!.replace(/\.md$/i, "")}`;
  const recording = posix.match(/^recordings\/([^/]+)$/i);
  if (recording) return `/memories/recordings/${recording[1]!.replace(/\.md$/i, "")}`;
  return `/memories/${posix}`;
}

export function notesPayload(workspace: Workspace, query: string, scope: NoteScope): NoteListPayload {
  const docs = listNoteDocuments(workspace.memory);
  const hits = searchNotes(docs, query, scope);
  return {
    scope,
    query,
    total: hits.length,
    items: hits.map((hit) => ({
      path: hit.path,
      title: hit.title,
      kind: hit.kind,
      snippet: hit.snippet,
      score: hit.score,
      updatedAt: hit.updatedAt,
      href: memoryHrefFor(hit.path),
    })),
  };
}

export interface NoteDetailPayload {
  file: MemoryFile;
  /** 可编辑正文，不含 YAML 头。 */
  body: string;
  frontmatter: Record<string, unknown>;
  revision: string;
  /** 正文里的 [[标题]]，解析不到会标出来。 */
  links: WikiLink[];
  /** 链到本页的页面。 */
  backlinks: Array<{ path: string; title: string; href: string }>;
}

/** 读一篇笔记，顺带把双链和反向链接算好。 */
export function noteDetail(workspace: Workspace, relativePath: string): NoteDetailPayload {
  const detail = readNote(workspace.memory, relativePath);
  const docs = listNoteDocuments(workspace.memory);
  const doc = docs.find((item) => item.path === detail.file.relativePath);
  const links = resolveWikiLinks(detail.body, docs);
  const backlinks = doc
    ? backlinksFor(doc, docs).map((item) => ({
        path: item.path,
        title: item.title,
        href: memoryHrefFor(item.path),
      }))
    : [];
  return {
    file: detail.file,
    body: detail.body,
    frontmatter: detail.frontmatter,
    revision: detail.revision,
    links,
    backlinks,
  };
}

/** 新建一篇日常笔记。 */
export function createNote(
  workspace: Workspace,
  input: { title: string; body?: string; date?: string },
): { file: MemoryFile; path: string; href: string } {
  const title = input.title.trim();
  if (!title) throw new Error("标题不能是空的");
  const relative = uniqueNotePath(workspace.memory, title, NOTES_DIR);
  const file = writeNote(workspace.memory, {
    path: relative,
    title,
    body: input.body ?? "",
    expectedRevision: "",
    kind: "note",
    date: input.date,
    actor: "owner",
  });
  return { file, path: file.relativePath, href: memoryHrefFor(file.relativePath) };
}

/** 保存一篇笔记的正文，YAML 头由服务端重新合成。 */
export function saveNote(
  workspace: Workspace,
  input: { path: string; body: string; expectedRevision: string; title?: string },
): { file: MemoryFile; body: string; revision: string } {
  const detail = readNote(workspace.memory, input.path);
  const title = input.title?.trim() || String(detail.frontmatter.title ?? detail.file.title);
  const file = writeNote(workspace.memory, {
    path: input.path,
    title,
    body: input.body,
    expectedRevision: input.expectedRevision,
    kind: detail.file.relativePath.startsWith(`${MEETINGS_DIR}/`) ? "meeting" : "note",
    actor: "owner",
  });
  const parsed = readNote(workspace.memory, file.relativePath);
  return { file, body: parsed.body, revision: parsed.revision };
}

/** 聊天里「写一页笔记」的落地：新建一篇日常笔记并给出可打开的链接。 */
export function createNoteFromChat(
  workspace: Workspace,
  input: { title: string; body: string; date?: string },
): { file: MemoryFile; path: string; href: string; title: string } {
  const title = input.title.trim() || `${input.date ?? ""} 的笔记`.trim() || "新笔记";
  const created = createNote(workspace, { title, body: input.body, date: input.date });
  return { ...created, title };
}

/** 笔记正文里出现过的双链，按标题解析。 */
export function noteLinks(workspace: Workspace, relativePath: string): WikiLink[] {
  const detail = readNote(workspace.memory, relativePath);
  return resolveWikiLinks(detail.body, listNoteDocuments(workspace.memory));
}

export function noteDocuments(workspace: Workspace): NoteDocument[] {
  return listNoteDocuments(workspace.memory);
}

/** 新建笔记时用的默认标题。 */
export function defaultNoteTitle(date: string): string {
  return `${date} 的笔记`;
}

export function noteToday(now: Date, timeZone: string): string {
  return dateInZone(now, timeZone);
}
