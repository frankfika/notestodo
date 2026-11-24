import { Button, Card, PageHeader } from "@huoye/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Link, useNavigate, useSearchParams } from "react-router";
import { visibleMemoryMarkdown } from "../lib/labels";
import { memoryHref } from "../lib/memory-path";
import { api, type NoteScope } from "../lib/api";

const FOLDERS = [
  { path: "about-you", name: "关于你", to: "/memories/about-you", description: "基本档案，可以一条条改。" },
  { path: "diaries", name: "日记", to: "/memories/diaries", description: "按天记下的事情。" },
  { path: "uploads", name: "导入", to: "/memories/uploads", description: "从外部放进来的文件。" },
  { path: "health", name: "健康", to: "/memories/health", description: "按天记下的睡眠、活动或心情。" },
  { path: "recordings", name: "录音", to: "/memories/recordings", description: "音频和纪要都在本机。" },
];

/** 检索范围：全部 / 日记 / 会议纪要 / 日常笔记 / 健康。 */
const SCOPES: Array<{ id: NoteScope; label: string }> = [
  { id: "all", label: "全部" },
  { id: "diary", label: "日记" },
  { id: "meeting", label: "会议纪要" },
  { id: "note", label: "日常笔记" },
  { id: "health", label: "健康" },
];

const SCOPE_IDS = SCOPES.map((item) => item.id);

/** URL 里的范围参数只认这几个值。 */
function scopeFromParam(raw: string | null): NoteScope {
  return raw && SCOPE_IDS.includes(raw as NoteScope) ? (raw as NoteScope) : "all";
}

const KIND_LABELS: Record<string, string> = {
  diary: "日记",
  meeting: "会议纪要",
  note: "日常笔记",
  health: "健康",
  other: "其他",
};

export function MemoriesPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tree = useQuery({ queryKey: ["memory-tree"], queryFn: api.tree });
  const about = useQuery({ queryKey: ["about-you"], queryFn: api.aboutYou });
  const [query, setQuery] = useState("");
  // 范围直接跟着地址走：刷新、分享、返回都还是这一页的范围。
  const scope = scopeFromParam(params.get("scope"));
  const notes = useQuery({
    queryKey: ["notes", query, scope],
    queryFn: () => api.notes(query, scope),
  });

  // 换范围：结果只留这个范围。
  function pickScope(next: NoteScope) {
    const nextParams = new URLSearchParams(params);
    nextParams.set("scope", next);
    setParams(nextParams, { replace: true });
  }

  // 「写一页笔记」：先建一页空的，再把人带过去写。
  const create = useMutation({
    mutationFn: () => api.createNote({ title: "" }),
    onSuccess: (created) => {
      void client.invalidateQueries({ queryKey: ["notes"] });
      void client.invalidateQueries({ queryKey: ["memory-tree"] });
      navigate(created.href);
    },
  });

  useEffect(() => {
    if (params.get("new") === "1" && !create.isPending) {
      const nextParams = new URLSearchParams(params);
      nextParams.delete("new");
      setParams(nextParams, { replace: true });
      create.mutate();
    }
    // 只在进入页面时处理一次 new=1。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const aboutDir = tree.data?.tree.find((n) => n.name === "about-you");
  const diaries = tree.data?.tree.find((n) => n.name === "diaries");
  const hits = notes.data?.items ?? [];
  const total = notes.data?.total ?? 0;
  const scopeLabel = SCOPES.find((item) => item.id === scope)?.label ?? "全部";

  return (
    <div className="pt-4 pb-28">
      <PageHeader
        title="记忆"
        description="这些记录都在你的工作区里，可以用普通编辑器打开，也可以一次性导出。"
        action={
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? "正在新建…" : "写一页笔记"}
          </Button>
        }
      />

      <section className="hy-note-search">
        <input
          className="hy-input"
          placeholder="全文搜索记忆…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="hy-note-scopes" role="group" aria-label="检索范围">
          {SCOPES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`hy-scope-chip ${scope === item.id ? "hy-scope-chip-on" : ""}`}
              aria-pressed={scope === item.id}
              onClick={() => pickScope(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="hy-note-count">
          <span className="hy-faint" style={{ fontSize: "var(--hy-fs-xs)" }}>
            {notes.isPending ? "正在找…" : `在「${scopeLabel}」里找到 ${total} 篇`}
          </span>
          {query ? (
            <button type="button" className="hy-link" onClick={() => setQuery("")}>
              一键清空
            </button>
          ) : null}
        </div>
      </section>

      <section className="mb-6">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <h2 className="hy-title text-lg">「{scopeLabel}」</h2>
          <span className="hy-faint text-xs">
            {notes.isPending ? "正在找…" : query ? `匹配「${query}」` : "这一范围里的全部内容"}
          </span>
        </div>
        <div className="space-y-2">
          {notes.isPending ? null : hits.length === 0 ? (
            <p className="hy-muted">这个范围里还没有内容。换个范围，或写一页新的。</p>
          ) : null}
          {hits.map((hit) => (
            <Link key={hit.path} to={hit.href} className="block no-underline">
              <Card className="p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <strong>{hit.title}</strong>
                  <span className="hy-faint text-xs">{KIND_LABELS[hit.kind] ?? hit.kind}</span>
                </div>
                <div className="hy-faint text-xs">{hit.path}</div>
                {hit.snippet ? <div className="text-sm mt-1">{hit.snippet}</div> : null}
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <Card className="p-5 mb-8">
        <div className="hy-faint text-xs tracking-wide uppercase">关于你</div>
        <h2 className="hy-title text-2xl mt-1">我对你的了解</h2>
        <div className="markdown-body mt-4 leading-7">
          <Markdown>{visibleMemoryMarkdown(about.data?.markdown ?? "")}</Markdown>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          {(aboutDir?.children ?? []).map((file) => (
            <Link key={file.relativePath} to={memoryHref(file.relativePath)} className="hy-btn hy-btn-ghost !py-1">
              {file.name.replace(".md", "")}
            </Link>
          ))}
        </div>
        <p className="hy-faint text-xs mt-3">这一页由「关于你」里的源文件汇总，请改那些源文件。</p>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FOLDERS.map((folder) => (
          <Link key={folder.path} to={folder.to} className="no-underline">
            <Card className="p-5 min-h-32">
              <div className="hy-title text-xl">{folder.name}</div>
              <p className="hy-muted text-sm">{folder.description}</p>
            </Card>
          </Link>
        ))}
      </div>
      {(diaries?.children ?? []).length ? (
        <div className="mt-6">
          <h3 className="hy-title text-xl">日记</h3>
          <div className="space-y-2">
            {diaries?.children?.map((file) => (
              <Link key={file.relativePath} className="block" to={memoryHref(file.relativePath)}>
                {file.name}
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <p className="hy-muted mt-6">还没有日记。和我多说一点，今天的事情会写在这里。</p>
      )}
    </div>
  );
}
