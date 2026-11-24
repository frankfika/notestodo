import { Button, Card, PageHeader } from "@huoye/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type NoteItem } from "../lib/api";
import { clearDraft, loadDraft, saveDraft } from "../lib/drafts";
import { memoryHref } from "../lib/memory-path";

interface TodoLine {
  index: number;
  done: boolean;
  text: string;
}

/** 一段正文里的片段：普通文字，或者一个 `[[双链]]`。 */
type Segment = { kind: "text"; text: string } | { kind: "link"; target: string };

/**
 * 待办行：`- [ ] 文字`、`* [x] 文字`、`1. [ ] 文字`，行首裸写的 `[ ] 文字` 也算。
 * 与 packages/memory/src/notes.ts 的 extractTodos / toggleTodoAt 是同一套写法，
 * 那边有单测；改动请两边一起改，勾选的序号才对得上。
 */
const TODO_LINE = /^(\s*)(?:([-*]|\d+\.)\s+)?\[([ xX])\]\s*(.*)$/;
const BARE_TODO_LINE = /^(\s*)\[([ xX])\]\s*(.*)$/;
const WIKI_LINK = /\[\[([^[\]\n]+)\]\]/g;

/** 正文里的待办，顺序与正文一致。 */
export function extractTodoLines(body: string): TodoLine[] {
  const out: TodoLine[] = [];
  for (const line of (body ?? "").split("\n")) {
    const match = line.match(TODO_LINE);
    if (!match) continue;
    out.push({ index: out.length, done: match[3]!.toLowerCase() === "x", text: match[4] ?? "" });
  }
  return out;
}

/**
 * 刚敲下的 `[ ] `、`[x] ` 转成待办行 `- [ ] `、`- [x] `。
 * 只动行首的方括号，句子中间的方括号不动。
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

/** 勾选第 index 条待办，行首的列表符号原样保留。 */
export function toggleTodoLine(body: string, index: number): string {
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

/** 把一段文字切成普通文字和 `[[双链]]` 交替的片段。 */
export function splitWikiLinkSegments(text: string): Segment[] {
  const source = text ?? "";
  const out: Segment[] = [];
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

/**
 * 按标题找双链指向的那一页：先找同名标题，再找同名文件，最后只看文件名。
 * 与服务端 packages/memory 的 findByTitle 是同一套认法。
 */
export function resolveTarget(target: string, docs: NoteItem[]): NoteItem | undefined {
  const key = (target ?? "").trim();
  if (!key) return undefined;
  const exact = docs.find((doc) => doc.title.trim() === key);
  if (exact) return exact;
  const base = key.replace(/\.md$/i, "");
  const byPath = docs.find((doc) => doc.path.replace(/\.md$/i, "") === base);
  if (byPath) return byPath;
  const name = base.split("/").pop() ?? base;
  return docs.find((doc) => doc.path.replace(/\.md$/i, "").split("/").pop() === name);
}

/**
 * 笔记编辑器：正文不含 YAML 头，标题聚焦，待办可勾选，双链可点，底部列出反向链接。
 */
export function NoteEditor({ path }: { path: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const file = useQuery({
    queryKey: ["note-file", path],
    queryFn: () => api.noteFile(path),
    enabled: Boolean(path),
    retry: false,
  });
  // 用来把 [[双链]] 解析成真正的那一页。
  const library = useQuery({
    queryKey: ["notes", "", "all"],
    queryFn: () => api.notes("", "all"),
    enabled: Boolean(path),
  });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [revision, setRevision] = useState("");
  const [message, setMessage] = useState("");
  const [draftNotice, setDraftNotice] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("edit");

  useEffect(() => {
    if (!file.data) return;
    const draft = loadDraft(path);
    if (draft && draft !== file.data.body) {
      setBody(draft);
      setDraftNotice(true);
    } else {
      setBody(file.data.body);
      setDraftNotice(false);
    }
    setTitle(file.data.file.title);
    setRevision(file.data.revision);
  }, [file.data, path]);

  useEffect(() => {
    if (path && body && file.data && body !== file.data.body) saveDraft(path, body);
  }, [body, path, file.data]);

  const save = useMutation({
    mutationFn: () => api.saveNote(path, body, revision, title),
    onSuccess: async (saved) => {
      clearDraft(path);
      setRevision(saved.revision);
      setBody(saved.body);
      setDraftNotice(false);
      setMessage("已保存");
      await client.invalidateQueries({ queryKey: ["note-file", path] });
      await client.invalidateQueries({ queryKey: ["notes"] });
      await client.invalidateQueries({ queryKey: ["memory-tree"] });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "保存失败");
    },
  });

  const toggle = useMutation({
    mutationFn: (index: number) => api.toggleNoteTodo(path, index),
    onSuccess: async (saved, index) => {
      // 服务端勾的是存盘的那一份；本地勾同一个位置，别把还没保存的改动冲掉。
      setBody((prev) => toggleTodoLine(prev, index));
      setRevision(saved.revision);
      setMessage("");
      await client.invalidateQueries({ queryKey: ["note-file", path] });
      await client.invalidateQueries({ queryKey: ["notes"] });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "勾选失败");
    },
  });

  // 双链指向的页面还不存在时，可以就地建一页。
  const createLinked = useMutation({
    mutationFn: (target: string) => api.createNote({ title: target }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ["notes"] });
      await client.invalidateQueries({ queryKey: ["memory-tree"] });
      navigate(created.href);
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "新建失败");
    },
  });

  if (file.isError) return <p className="hy-muted">打不开这一页：{(file.error as Error)?.message}</p>;
  if (!file.data) return <p className="hy-muted pt-8">正在打开…</p>;

  const todos = extractTodoLines(body);
  const links = file.data.links ?? [];
  const backlinks = file.data.backlinks ?? [];
  const docs = library.data?.items ?? [];

  function renderSegments(text: string) {
    return splitWikiLinkSegments(text).map((segment, i) => {
      if (segment.kind === "text") return <span key={i}>{segment.text}</span>;
      const hit = resolveTarget(segment.target, docs);
      if (hit) {
        return (
          <Link key={i} to={hit.href} className="hy-link">
            {segment.target}
          </Link>
        );
      }
      return (
        <span key={i} style={{ whiteSpace: "nowrap" }}>
          <span className="hy-faint" style={{ borderBottom: "1px dashed currentColor" }} title="还没有这一页">
            {segment.target}
          </span>
          <button
            type="button"
            className="hy-link"
            style={{ fontSize: "var(--hy-fs-xs)", marginLeft: 4 }}
            disabled={createLinked.isPending}
            onClick={() => createLinked.mutate(segment.target)}
          >
            建这一页
          </button>
        </span>
      );
    });
  }

  return (
    <div className="pt-4">
      <PageHeader
        eyebrow={path}
        title={file.data.file.title || "新的一页"}
        description="这一页只存正文，YAML 头由活页自己维护。离开页面后草稿会留在本机。"
      />
      {draftNotice ? <p className="text-sm">发现未保存草稿，已为你恢复。</p> : null}
      <div className="hy-note-editor">
        <input
          className="hy-input hy-note-title"
          value={title}
          autoFocus
          placeholder="这一页的标题"
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="flex gap-2" role="group" aria-label="编辑或预览">
          <Button tone={mode === "edit" ? "primary" : "quiet"} aria-pressed={mode === "edit"} onClick={() => setMode("edit")}>
            编辑
          </Button>
          <Button tone={mode === "preview" ? "primary" : "quiet"} aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
            预览
          </Button>
        </div>
        {mode === "edit" ? (
          <textarea
            className="hy-textarea min-h-[22rem] font-[var(--hy-font-mono)] text-sm leading-7"
            value={body}
            placeholder="写点什么。行首敲 `[ ] ` 或 `[x] ` 会自动变成待办。"
            onChange={(e) => {
              setBody(normalizeTodoLines(e.target.value));
              setMessage("");
            }}
          />
        ) : (
          <Card className="p-4">
            <div className="markdown-body hy-note-body" style={{ fontSize: "var(--hy-fs-base)" }}>
              {previewBlocks(body).map((block) => {
                if (block.todo) {
                  return (
                    <div key={block.key} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={block.todo.done}
                        onChange={() => toggle.mutate(block.todo!.index)}
                        aria-label={block.todo.text}
                        style={{ marginTop: 6 }}
                      />
                      <span style={{ textDecoration: block.todo.done ? "line-through" : "none" }}>{renderSegments(block.todo.text)}</span>
                    </div>
                  );
                }
                return (
                  <div key={block.key} style={{ minHeight: "1.4em" }}>
                    {renderSegments(block.text)}
                  </div>
                );
              })}
            </div>
            {!body.trim() ? <p className="hy-faint text-xs">这一页还是空的。</p> : null}
          </Card>
        )}
        {mode === "edit" && todos.length ? (
          <Card className="p-4">
            <div className="hy-eyebrow" style={{ marginBottom: 8 }}>
              待办
            </div>
            <ul className="space-y-2">
              {todos.map((todo) => (
                <li key={todo.index} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={todo.done}
                    onChange={() => toggle.mutate(todo.index)}
                    aria-label={todo.text}
                    style={{ marginTop: 4 }}
                  />
                  <span style={{ textDecoration: todo.done ? "line-through" : "none" }}>{renderSegments(todo.text)}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "正在保存…" : "保存"}
          </Button>
          <Link to="/memories" className="hy-btn hy-btn-ghost">
            回到记忆
          </Link>
        </div>
        {message ? <p className="text-sm mt-2">{message}</p> : null}

        {links.length ? (
          <section className="hy-note-block">
            <h2 className="hy-section-title" style={{ fontSize: "var(--hy-fs-md)" }}>
              正文里的链接
            </h2>
            <ul className="space-y-1" style={{ fontSize: "var(--hy-fs-sm)" }}>
              {links.map((link) => (
                <li key={link.target}>
                  {link.resolved && link.path ? (
                    <Link to={memoryHref(link.path)} className="hy-link">
                      {link.target}
                    </Link>
                  ) : (
                    <span className="hy-faint">
                      [[{link.target}]] 还没有对应的页面
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="hy-note-block">
          <h2 className="hy-section-title" style={{ fontSize: "var(--hy-fs-md)" }}>
            反向链接{backlinks.length ? `（${backlinks.length}）` : ""}
          </h2>
          {backlinks.length === 0 ? (
            <p className="hy-faint" style={{ fontSize: "var(--hy-fs-sm)" }}>
              还没有别的页面链到这里。
            </p>
          ) : (
            <ul className="space-y-1" style={{ fontSize: "var(--hy-fs-sm)" }}>
              {backlinks.map((item) => (
                <li key={item.path}>
                  <Link to={item.href} className="hy-link">
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** 预览用的一行：要么是待办，要么是普通文字。 */
interface PreviewBlock {
  key: string;
  text: string;
  todo?: { index: number; done: boolean; text: string };
}

/** 把正文按行拆开，标出哪些行是待办、待办是第几条。 */
function previewBlocks(body: string): PreviewBlock[] {
  const out: PreviewBlock[] = [];
  let todoIndex = -1;
  (body ?? "").split("\n").forEach((line, i) => {
    const match = line.match(TODO_LINE);
    if (match) {
      todoIndex += 1;
      const text = match[4] ?? "";
      out.push({
        key: `todo-${todoIndex}`,
        text,
        todo: { index: todoIndex, done: match[3]!.toLowerCase() === "x", text },
      });
      return;
    }
    out.push({ key: `line-${i}`, text: line });
  });
  return out;
}
