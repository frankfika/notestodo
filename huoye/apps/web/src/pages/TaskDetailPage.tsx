import { Button, Card, PageHeader, Pill } from "@huoye/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { taskScheduleLabel, taskStatusLabel } from "../lib/labels";
import { api } from "../lib/api";

export function TaskDetailPage() {
  const { id } = useParams();
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["task", id],
    queryFn: () => api.task(id!),
    enabled: Boolean(id),
  });
  const run = useMutation({
    mutationFn: () => api.runTask(id!),
    onSuccess: async (data) => {
      client.setQueryData(["task", id], data);
      await client.invalidateQueries({ queryKey: ["task", id] });
      await client.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelTask(id!),
    onSuccess: async (data) => {
      client.setQueryData(["task", id], (current) => {
        const events = current && typeof current === "object" && "events" in current ? current.events : [];
        return { task: data.task, events };
      });
      await client.invalidateQueries({ queryKey: ["task", id] });
      await client.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const task = detail.data?.task;
  if (!task) return <p className="hy-muted pt-8">正在打开任务…</p>;
  const statusLabel = run.isPending ? "运行中" : taskStatusLabel(task.status);

  return (
    <div className="pt-4">
      <PageHeader
        title={task.title}
        description={task.instruction}
        action={<Pill>{statusLabel}</Pill>}
      />
      {task.schedule ? (
        <p className="hy-muted text-sm mb-3">{taskScheduleLabel(task.schedule)}</p>
      ) : null}
      <div className="flex gap-2 mb-6">
        <Button onClick={() => run.mutate()} disabled={run.isPending || task.status === "cancelled" || task.status === "running"}>
          {run.isPending ? "正在运行…" : "运行"}
        </Button>
        <Button tone="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending || task.status === "cancelled" || task.status === "completed"}>
          取消
        </Button>
        <Link to="/chat" className="hy-btn hy-btn-ghost">
          回到聊天
        </Link>
      </div>
      {run.isError ? <p className="text-sm text-[var(--hy-danger)] mb-4">{run.error.message}</p> : null}
      {cancel.isError ? <p className="text-sm text-[var(--hy-danger)] mb-4">{cancel.error.message}</p> : null}
      <h2 className="hy-title text-2xl">运行记录</h2>
      {(detail.data?.events ?? []).length === 0 ? (
        <p className="hy-muted">还没有运行记录。点运行后，过程和结果会出现在这里。</p>
      ) : (
        <div className="space-y-3">
          {detail.data?.events.map((event) => (
            <Card key={event.id} className="p-4">
              <div className="hy-faint text-xs">
                {event.type} · {event.at}
              </div>
              <div className="mt-1 whitespace-pre-wrap">{event.message}</div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
