import { Button, Card, PageHeader, Pill } from "@huoye/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { ApiError, api, type ConflictBody } from "../lib/api";
import { clearDraft, loadDraft, saveDraft } from "../lib/drafts";
import { ConflictDialog } from "../components/ConflictDialog";
import { memoryPathFromRoute } from "../lib/memory-path";
import { NoteEditor } from "./NoteEditor";

/** 笔记和纪要走笔记编辑器：正文不带 YAML 头。 */
export function isNotePath(path: string): boolean {
  return /^(notes|meetings)\//i.test(path);
}

export function MemoryEditorPage() {
  const params = useParams();
  const location = useLocation();
  const client = useQueryClient();
  const path = useMemo(() => resolvePath(params, location.pathname), [params, location.pathname]);
  const file = useQuery({
    queryKey: ["memory-file", path],
    queryFn: () => api.memoryFile(path),
    enabled: Boolean(path) && !isNotePath(path),
  });
  const [content, setContent] = useState("");
  const [revision, setRevision] = useState("");
  const [draftNotice, setDraftNotice] = useState(false);
  const [conflict, setConflict] = useState<ConflictBody | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!file.data) return;
    const draft = loadDraft(path);
    if (draft && draft !== file.data.content) {
      setContent(draft);
      setDraftNotice(true);
    } else {
      setContent(file.data.content);
      setDraftNotice(false);
    }
    setRevision(file.data.revision);
  }, [file.data, path]);

  useEffect(() => {
    if (path && content && file.data && content !== file.data.content) saveDraft(path, content);
  }, [content, path, file.data]);

  const save = useMutation({
    mutationFn: async (expectedRevision: string) => api.saveMemoryFile(path, content, expectedRevision),
    onSuccess: async (saved) => {
      clearDraft(path);
      setRevision(saved.revision);
      setContent(saved.content);
      setDraftNotice(false);
      setMessage("已保存");
      setConflict(null);
      await client.invalidateQueries({ queryKey: ["memory-file", path] });
      await client.invalidateQueries({ queryKey: ["about-you"] });
      await client.invalidateQueries({ queryKey: ["memory-tree"] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(error.body as ConflictBody);
        setMessage("");
        return;
      }
      setMessage(error instanceof Error ? error.message : "保存失败");
    },
  });

  const pin = useMutation({
    mutationFn: () => api.pin(path, !file.data?.pinned),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["memory-file", path] });
    },
  });

  if (!path) return <p className="hy-muted">缺少文件路径。</p>;
  if (isNotePath(path)) return <NoteEditor path={path} />;
  if (file.isError) return <p className="hy-muted">打不开这个文件：{file.error.message}</p>;
  if (!file.data) return <p className="hy-muted pt-8">正在打开…</p>;

  const readonly = file.data.readonly;

  return (
    <div className="pt-4">
      <PageHeader
        eyebrow={path}
        title={file.data.title}
        description={readonly ? "由活页生成，不可直接编辑。请改源文件，或重新生成。" : "离开页面后草稿会留在本机，不会偷偷丢掉。"}
        action={
          <div className="flex gap-2">
            {file.data.pinned ? <Pill>已置顶</Pill> : null}
            {readonly ? <Pill>只读</Pill> : null}
          </div>
        }
      />
      {draftNotice ? <p className="text-sm">发现未保存草稿，已为你恢复。若不需要，可以丢弃草稿。</p> : null}
      {readonly ? (
        <Card className="p-5 whitespace-pre-wrap leading-7">{file.data.content}</Card>
      ) : (
        <textarea className="hy-textarea min-h-[28rem] font-[var(--hy-font-mono)] text-sm" value={content} onChange={(e) => setContent(e.target.value)} />
      )}
      <div className="flex flex-wrap gap-2 mt-4">
        {readonly ? (
          <Link to="/memories/about-you/profile.md" className="hy-btn">
            编辑源文件
          </Link>
        ) : (
          <Button onClick={() => save.mutate(revision)} disabled={save.isPending}>
            保存
          </Button>
        )}
        <Button tone="ghost" onClick={() => pin.mutate()}>
          {file.data.pinned ? "取消置顶" : "置顶"}
        </Button>
        {draftNotice ? (
          <Button
            tone="ghost"
            onClick={() => {
              setContent(file.data!.content);
              clearDraft(path);
              setDraftNotice(false);
            }}
          >
            丢弃草稿
          </Button>
        ) : null}
        <Link to="/chat" className="hy-btn hy-btn-ghost">
          回到聊天
        </Link>
      </div>
      {message ? <p className="text-sm mt-2">{message}</p> : null}
      <ConflictDialog
        open={Boolean(conflict)}
        conflict={conflict}
        draft={content}
        onClose={() => setConflict(null)}
        onDiscard={() => {
          if (!conflict) return;
          setContent(conflict.current.content);
          setRevision(conflict.current.revision);
          clearDraft(path);
          setConflict(null);
          setDraftNotice(false);
        }}
        onOverwrite={() => {
          if (!conflict) return;
          save.mutate(conflict.current.revision);
        }}
      />
    </div>
  );
}

function resolvePath(params: Record<string, string | undefined>, pathname: string): string {
  return memoryPathFromRoute({ date: params.date }, pathname);
}
