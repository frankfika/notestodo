import { Button, PageHeader } from "@huoye/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { api } from "../lib/api";

export function TaskNewPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const seed = (location.state as { instruction?: string } | null)?.instruction ?? "";
  const [title, setTitle] = useState(seed.slice(0, 24));
  const [instruction, setInstruction] = useState(seed);
  const [kind, setKind] = useState<"on_demand" | "scheduled">("on_demand");
  const [repeat, setRepeat] = useState<"once" | "daily">("once");
  const [runAt, setRunAt] = useState("");
  const [timeOfDay, setTimeOfDay] = useState("21:00");
  const [hint, setHint] = useState("");
  const timezone = settings.data?.timezone ?? "Asia/Shanghai";

  const create = useMutation({
    mutationFn: () => {
      if (kind === "scheduled" && repeat === "once" && !runAt.trim()) {
        throw new Error("请先选一个计划时间。");
      }
      return api.createTask({
        title: title.trim() || instruction.trim().slice(0, 24) || "未命名任务",
        instruction: instruction.trim() || title.trim(),
        kind,
        schedule:
          kind === "scheduled"
            ? repeat === "daily"
              ? {
                  kind: "cron",
                  cron: dailyCron(timeOfDay),
                  timezone,
                  enabled: true,
                }
              : { kind: "once", runAt: runAt || undefined, timezone, enabled: true }
            : undefined,
      });
    },
    onSuccess: async (task) => {
      await client.invalidateQueries({ queryKey: ["tasks"] });
      navigate(`/tasks/${task.id}`);
    },
    onError: (error) => {
      setHint(error instanceof Error ? error.message : "无法创建任务");
    },
  });

  return (
    <div className="pt-4 max-w-xl">
      <PageHeader title="新建任务" description="即时任务可以马上运行。定时任务会记下时间，到点由本机自动跑，不必再点一次运行。" />
      <label className="block mb-3">
        <div className="text-sm hy-muted mb-1">标题</div>
        <input className="hy-input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="block mb-3">
        <div className="text-sm hy-muted mb-1">说明</div>
        <textarea className="hy-textarea" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      </label>
      <div className="flex gap-2 mb-3">
        <Button tone={kind === "on_demand" ? "primary" : "ghost"} type="button" onClick={() => setKind("on_demand")}>
          即时
        </Button>
        <Button tone={kind === "scheduled" ? "primary" : "ghost"} type="button" onClick={() => setKind("scheduled")}>
          定时
        </Button>
      </div>
      {kind === "scheduled" ? (
        <div className="mb-3 space-y-3">
          <div className="flex gap-2">
            <Button tone={repeat === "once" ? "primary" : "ghost"} type="button" onClick={() => setRepeat("once")}>
              一次
            </Button>
            <Button tone={repeat === "daily" ? "primary" : "ghost"} type="button" onClick={() => setRepeat("daily")}>
              每天
            </Button>
          </div>
          {repeat === "once" ? (
            <label className="block">
              <div className="text-sm hy-muted mb-1">计划时间</div>
              <input className="hy-input" type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
            </label>
          ) : (
            <label className="block">
              <div className="text-sm hy-muted mb-1">每天的运行时刻</div>
              <input className="hy-input" type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} />
            </label>
          )}
          <p className="hy-muted text-xs">
            到点会自动运行。若服务器当时没在，恢复后会补跑一次；每天重复的任务不会把错过的每一档都补上，只跑最近这一次，再排到下一档。
          </p>
        </div>
      ) : null}
      {hint ? <p className="text-sm text-[var(--hy-danger)] mb-3">{hint}</p> : null}
      <Button onClick={() => create.mutate()} disabled={create.isPending || (!title.trim() && !instruction.trim())}>
        创建
      </Button>
    </div>
  );
}

function dailyCron(time: string): string {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  const hour = match ? Number(match[1]) : 21;
  const minute = match ? Number(match[2]) : 0;
  return `${minute} ${hour} * * *`;
}
