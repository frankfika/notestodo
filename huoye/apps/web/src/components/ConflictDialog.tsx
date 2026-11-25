import { Button, Card } from "@huoye/ui";
import { createTwoFilesPatch } from "diff";
import type { ConflictBody } from "../lib/api";

export function ConflictDialog({
  open,
  conflict,
  draft,
  onOverwrite,
  onDiscard,
  onClose,
}: {
  open: boolean;
  conflict: ConflictBody | null;
  draft: string;
  onOverwrite: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  if (!open || !conflict) return null;
  const diff = createTwoFilesPatch("磁盘最新版", "我的草稿", conflict.current.content, draft, undefined, undefined, {
    context: 2,
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/25 grid place-items-center p-4">
      <Card className="max-w-2xl w-full p-6 max-h-[86vh] overflow-auto" strong>
        <h2 className="hy-title text-2xl mt-0">文件已被改过</h2>
        <p className="hy-muted">磁盘上的版本和你正在编辑的草稿不一样。活页不会静默覆盖。</p>
        <div className="grid gap-4 md:grid-cols-2 mt-4">
          <section>
            <h3 className="text-sm hy-muted mt-0">磁盘最新版</h3>
            <pre className="text-xs whitespace-pre-wrap bg-white/80 rounded-2xl p-3 max-h-48 overflow-auto font-[var(--hy-font-mono)]">
              {conflict.current.content}
            </pre>
          </section>
          <section>
            <h3 className="text-sm hy-muted mt-0">差异</h3>
            <pre className="text-xs whitespace-pre-wrap bg-white/80 rounded-2xl p-3 max-h-48 overflow-auto font-[var(--hy-font-mono)]">
              {diff}
            </pre>
          </section>
        </div>
        <div className="flex flex-wrap gap-2 mt-5">
          <Button onClick={onOverwrite}>用我的草稿覆盖</Button>
          <Button tone="ghost" onClick={onDiscard}>
            丢弃草稿
          </Button>
          <Button tone="ghost" onClick={onClose}>
            先看看
          </Button>
        </div>
      </Card>
    </div>
  );
}
