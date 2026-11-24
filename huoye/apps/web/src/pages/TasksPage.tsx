import { Button, Card, PageHeader, Pill } from "@huoye/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import type { Task } from "@huoye/schema";
import { taskScheduleLabel, taskStatusLabel } from "../lib/labels";
import { api } from "../lib/api";

function groupTasks(items: Task[], timeZone: string) {
  const today = dateStamp(new Date(), timeZone);
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dateStamp(yesterdayDate, timeZone);
  const groups: Array<{ label: string; items: Task[] }> = [
    { label: "今天", items: [] },
    { label: "昨天", items: [] },
    { label: "更早", items: [] },
  ];
  for (const task of items) {
    const stamp = dateStamp(new Date(task.createdAt), timeZone);
    if (stamp === today) groups[0]!.items.push(task);
    else if (stamp === yesterday) groups[1]!.items.push(task);
    else groups[2]!.items.push(task);
  }
  return groups.filter((g) => g.items.length);
}

function dateStamp(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function TasksPage() {
  const navigate = useNavigate();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
  const items = tasks.data?.items ?? [];
  const onDemand = items.filter((t) => t.kind === "on_demand");
  const scheduled = items.filter((t) => t.kind === "scheduled");
  const tz = settings.data?.timezone ?? "Asia/Shanghai";

  return (
    <div className="pt-4">
      <PageHeader
        title="任务"
        description="即时任务可以马上运行。定时任务到点会由本机自动跑；关掉服务器期间错过的时间，恢复后只会补跑一次。"
        action={<Button onClick={() => navigate("/tasks/new")}>新建任务</Button>}
      />
      <section>
        <h2 className="hy-title text-2xl">即时</h2>
        {onDemand.length === 0 ? <p className="hy-muted">还没有即时任务。</p> : renderGroups(groupTasks(onDemand, tz))}
      </section>
      <section className="mt-8">
        <h2 className="hy-title text-2xl">定时</h2>
        {scheduled.length === 0 ? <p className="hy-muted">还没有定时任务。</p> : renderGroups(groupTasks(scheduled, tz))}
      </section>
    </div>
  );
}

function renderGroups(groups: Array<{ label: string; items: Task[] }>) {
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="hy-faint text-sm mb-2">{group.label}</div>
          <div className="space-y-3">
            {group.items.map((task) => (
              <Link key={task.id} to={`/tasks/${task.id}`} className="no-underline">
                <Card className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div>{task.title}</div>
                      <div className="hy-faint text-sm line-clamp-1">{task.instruction}</div>
                      {task.schedule ? (
                        <div className="hy-muted text-xs mt-1">{taskScheduleLabel(task.schedule)}</div>
                      ) : null}
                    </div>
                    <Pill>{taskStatusLabel(task.status)}</Pill>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
