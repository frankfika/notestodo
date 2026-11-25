import { Card, PageHeader, Pill } from "@huoye/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { api } from "../lib/api";
import { memoryHref } from "../lib/memory-path";
import { MemoryEditorPage } from "./MemoryEditorPage";

const FOLDER_TITLES: Record<string, { title: string; description: string }> = {
  "about-you": { title: "关于你", description: "基本档案，可以一条条改。" },
  diaries: { title: "日记", description: "按天记下的事情。" },
  uploads: { title: "导入", description: "从外部放进来的文件。" },
  health: { title: "健康", description: "按天记下的睡眠、活动或心情。" },
  recordings: { title: "录音", description: "音频和纪要都在本机。" },
};

export function MemoryRoutePage() {
  const location = useLocation();
  const path = decodeURIComponent(location.pathname.replace(/^\/memories\//, ""));
  const folder = useQuery({
    queryKey: ["memory-folder", path],
    queryFn: () => api.memoryFolder(path),
    retry: false,
    enabled: Boolean(path),
  });

  if (!path) return <p className="hy-muted">缺少路径。</p>;
  if (folder.isLoading) return <p className="hy-muted pt-8">正在打开…</p>;
  if (folder.data?.type === "dir") return <MemoryFolderView path={path} />;
  return <MemoryEditorPage />;
}

export function MemoryFolderPage() {
  const location = useLocation();
  const path = decodeURIComponent(location.pathname.replace(/^\/memories\//, ""));
  return <MemoryFolderView path={path} />;
}

function MemoryFolderView({ path }: { path: string }) {
  const known = FOLDER_TITLES[path];
  const meta = known ?? { title: path, description: "这个文件夹里的记忆文件。" };
  const folder = useQuery({
    queryKey: ["memory-folder", path],
    queryFn: () => api.memoryFolder(path),
    enabled: Boolean(path),
  });
  const children = folder.data?.children ?? [];

  return (
    <div className="pt-4">
      <PageHeader
        eyebrow={known ? meta.title : "记忆"}
        title={meta.title}
        description={meta.description}
        action={
          <Link to="/memories" className="hy-btn hy-btn-ghost">
            返回记忆
          </Link>
        }
      />
      <p className="hy-faint text-xs mb-4">{path}</p>
      {folder.isError ? <p className="hy-muted">打不开这个文件夹。</p> : null}
      {folder.isLoading ? <p className="hy-muted">正在打开…</p> : null}
      {!folder.isLoading && !folder.isError && children.length === 0 ? (
        <p className="hy-muted">这个文件夹现在还是空的。</p>
      ) : (
        <div className="space-y-3">
          {children.map((child) => (
            <Link key={child.relativePath} to={memoryHref(child.relativePath)} className="block no-underline">
              <Card className="p-4 flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{child.name.replace(/\.md$/, "")}</div>
                  <div className="hy-faint text-xs">{child.relativePath}</div>
                </div>
                <Pill>{child.type === "dir" ? "文件夹" : "文件"}</Pill>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
