import type { Task, TaskStatus } from "@huoye/schema";

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  draft: "草稿",
  pending_confirmation: "待确认",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  scheduled: "已排期",
};

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status as TaskStatus] ?? status;
}

export function stripHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "").trim();
}


export function visibleMemoryMarkdown(markdown: string): string {
  return (markdown ?? "")
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*>\s*由活页根据[^\n]*\n+/gm, "")
    .replace(/^\s*[-*]\s*出处[：:].+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const HOME_OPEN_STATUSES = new Set(["draft", "pending_confirmation", "running", "scheduled"]);

export function selectHomeTasks<T extends { status: string; updatedAt: string }>(
  items: T[],
  todayPrefix: string,
): T[] {
  const open = items.filter((task) => HOME_OPEN_STATUSES.has(task.status));
  const doneToday = items.filter(
    (task) =>
      (task.status === "completed" || task.status === "failed") &&
      task.updatedAt.slice(0, 10) === todayPrefix,
  );
  return [...open, ...doneToday].slice(0, 5);
}

export function taskScheduleLabel(schedule: Task["schedule"], now = new Date()): string | undefined {
  if (!schedule) return undefined;
  const tz = schedule.timezone || "Asia/Shanghai";
  const when = schedule.nextRunAt ?? (schedule.kind === "once" ? schedule.runAt : undefined);
  const whenText = when ? formatWhenZh(when, tz, now) : "";
  if (schedule.kind === "cron") {
    const clock = dailyClock(schedule.cron);
    const head = clock ? `每天 ${clock}` : schedule.cron ? `按周期 ${schedule.cron}` : "按周期";
    return whenText ? `${head}，下次 ${whenText}` : head;
  }
  return whenText ? `一次，${whenText}` : "一次";
}

function dailyClock(cron: string | undefined): string | undefined {
  if (!cron) return undefined;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return undefined;
  const shift = fields.length === 6 ? 1 : 0;
  const minute = fields[shift];
  const hour = fields[shift + 1];
  if (!minute || !hour || minute.includes("*") || hour.includes("*") || minute.includes(",") || hour.includes(",")) {
    return undefined;
  }
  if ((fields[shift + 2] ?? "*") !== "*" || (fields[shift + 3] ?? "*") !== "*" || (fields[shift + 4] ?? "*") !== "*") {
    return undefined;
  }
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return undefined;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatWhenZh(iso: string, timeZone: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hour = padPart(date, timeZone, "hour");
  const minute = padPart(date, timeZone, "minute");
  const clock = `${hour}:${minute}`;
  const stamp = stampOf(date, timeZone);
  if (stamp === stampOf(now, timeZone)) return `今天 ${clock}`;
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (stamp === stampOf(tomorrow, timeZone)) return `明天 ${clock}`;
  const month = Number(partOf(date, timeZone, "month"));
  const day = Number(partOf(date, timeZone, "day"));
  return `${month}月${day}日 ${clock}`;
}

function stampOf(date: Date, timeZone: string): string {
  return `${partOf(date, timeZone, "year")}-${partOf(date, timeZone, "month")}-${partOf(date, timeZone, "day")}`;
}

function padPart(date: Date, timeZone: string, type: "hour" | "minute"): string {
  return partOf(date, timeZone, type);
}

function partOf(date: Date, timeZone: string, type: "year" | "month" | "day" | "hour" | "minute"): string {
  return (
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .find((item) => item.type === type)?.value ?? ""
  );
}
