import { Button, Card, PageHeader, Pill } from "@huoye/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Markdown from "react-markdown";
import { Link, useParams } from "react-router";
import { api } from "../lib/api";
import { visibleMemoryMarkdown } from "../lib/labels";

export function HealthPage() {
  const { date } = useParams();
  const client = useQueryClient();
  const notes = useQuery({ queryKey: ["health-notes"], queryFn: api.healthNotes });
  const [sleep, setSleep] = useState("");
  const [movement, setMovement] = useState("");
  const [mood, setMood] = useState("");
  const [note, setNote] = useState("");
  const [hint, setHint] = useState("");

  const save = useMutation({
    mutationFn: () => api.saveHealthNote({ sleep, movement, mood, note }),
    onSuccess: async () => {
      setSleep("");
      setMovement("");
      setMood("");
      setNote("");
      setHint("已经记到今天的健康记录里。");
      await client.invalidateQueries({ queryKey: ["health-notes"] });
      await client.invalidateQueries({ queryKey: ["today-cards"] });
      await client.invalidateQueries({ queryKey: ["memory-tree"] });
    },
    onError: (error) => {
      setHint(error instanceof Error ? error.message : "没有记下。");
    },
  });

  const today = notes.data?.today;
  const items = notes.data?.items ?? [];
  const selected = date ? items.find((item) => item.date === date.replace(/\.md$/i, "")) : undefined;

  return (
    <div className="pt-4 pb-24">
      <PageHeader
        title="健康"
        description="今天的睡眠、活动或心情，可以记在这里。这些记录都在你的工作区里，可以随时导出。"
        action={
          <Link to="/memories" className="hy-btn hy-btn-ghost">
            返回记忆
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <Card className="p-5">
          <h2 className="hy-title text-xl m-0">记下今天</h2>
          <p className="hy-muted text-sm mt-1">不必填全，写一项就可以。</p>
          <label className="block mt-4 text-sm">
            睡眠
            <input className="hy-input mt-1" value={sleep} onChange={(e) => setSleep(e.target.value)} placeholder="比如：睡了多久" />
          </label>
          <label className="block mt-3 text-sm">
            活动
            <input className="hy-input mt-1" value={movement} onChange={(e) => setMovement(e.target.value)} placeholder="比如：今天活动了什么" />
          </label>
          <label className="block mt-3 text-sm">
            心情
            <input className="hy-input mt-1" value={mood} onChange={(e) => setMood(e.target.value)} placeholder="比如：今天心情怎么样" />
          </label>
          <label className="block mt-3 text-sm">
            备注
            <textarea className="hy-textarea mt-1 min-h-[6rem]" value={note} onChange={(e) => setNote(e.target.value)} placeholder="还有想留下的一句" />
          </label>
          {hint ? <p className="text-sm mt-3">{hint}</p> : null}
          <div className="mt-4">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "正在记下…" : "记下"}
            </Button>
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="hy-title text-xl m-0">数据来源</h2>
          <p className="hy-muted text-sm mt-2">手记已经可以在这页使用。</p>
          <div className="flex items-center justify-between gap-3 mt-3">
            <span>手表或健康应用</span>
            <Pill>未连接</Pill>
          </div>
          <p className="hy-faint text-xs mt-2">还没有接入设备时，不会显示成已连接。</p>
        </Card>
      </div>

      <Card className="p-5 mt-4">
        <h2 className="hy-title text-xl m-0">今天</h2>
        {today?.exists ? (
          <>
            <p className="hy-muted text-sm mt-1">{today.summary}</p>
            <div className="markdown-body mt-3 leading-7">
              <Markdown>{visibleMemoryMarkdown(today.content)}</Markdown>
            </div>
          </>
        ) : (
          <p className="hy-muted mt-2">今天还没有健康记录。</p>
        )}
      </Card>

      {items.length ? (
        <div className="mt-6">
          <h3 className="hy-title text-xl">以前的记录</h3>
          <div className="space-y-2 mt-3">
            {items.map((item) => (
              <Link key={item.path} to={`/memories/health/${item.date}`} className="block no-underline">
                <Card className={`p-4 ${selected?.path === item.path ? "hy-glass-strong" : ""}`}>
                  <div className="font-medium">{item.date}</div>
                  <div className="hy-muted text-sm">{item.summary || item.title}</div>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
