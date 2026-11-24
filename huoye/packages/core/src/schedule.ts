import {
  civilToIso,
  formatIso,
  type Task,
  type TaskSchedule,
} from "@huoye/schema";

/**
 * 本地调度约定（活页自己的实现合同）：
 *
 * - 到点后由 API 进程内的定时器触发，不必另起守护进程。
 * - 服务器关闭期间错过的到期时间：恢复后补跑一次。周期任务不会把错过的每一次都补上，
 *   只跑最近这一次，再把下次排到「现在之后」的下一档。
 * - 一次性任务跑完（成功或失败）后不再自动触发。
 * - 周期任务无论成功或失败，都会把下次排到现在之后，避免失败后每个轮询周期都重试。
 */

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export interface ParsedCron {
  seconds?: Set<number>;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  hasSeconds: boolean;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new ScheduleError("cron 需要五位或六位（可选秒）");
  }
  const hasSeconds = fields.length === 6;
  const seconds = hasSeconds ? parseField(fields[0]!, 0, 59, {}) : undefined;
  const shift = hasSeconds ? 1 : 0;
  const daysOfMonthExpr = fields[shift + 2]!;
  const daysOfWeekExpr = fields[shift + 4]!;
  return {
    seconds,
    minutes: parseField(fields[shift]!, 0, 59, {}),
    hours: parseField(fields[shift + 1]!, 0, 23, {}),
    daysOfMonth: parseField(daysOfMonthExpr, 1, 31, {}),
    months: parseField(fields[shift + 3]!, 1, 12, MONTHS),
    daysOfWeek: parseField(daysOfWeekExpr, 0, 7, WEEKDAYS, { sundaySeven: true }),
    hasSeconds,
    domRestricted: daysOfMonthExpr !== "*",
    dowRestricted: daysOfWeekExpr !== "*",
  };
}

export function normalizeSchedule(
  input: Partial<TaskSchedule> | undefined,
  options: { now?: Date; timezone?: string },
): TaskSchedule {
  const timezone = input?.timezone?.trim() || options.timezone || "Asia/Shanghai";
  const now = options.now ?? new Date();
  const kind = input?.kind === "cron" ? "cron" : "once";
  const enabled = input?.enabled !== false;

  if (kind === "once") {
    if (!input?.runAt?.trim()) throw new ScheduleError("定时任务需要一个计划时间");
    const runAt = civilToIso(input.runAt, timezone);
    return {
      kind: "once",
      runAt,
      timezone,
      enabled,
      nextRunAt: enabled ? runAt : undefined,
    };
  }

  if (!input?.cron?.trim()) throw new ScheduleError("周期任务需要一条 cron");
  const cron = input.cron.trim();
  parseCron(cron);
  const createdOrNow = now;
  const next =
    nextCronOccurrence(cron, createdOrNow, timezone, { inclusive: true }) ??
    undefined;
  return {
    kind: "cron",
    cron,
    timezone,
    enabled,
    nextRunAt: enabled ? (input.nextRunAt ? civilToIso(input.nextRunAt, timezone) : next ? formatIso(next, timezone) : undefined) : undefined,
  };
}

export function resolveDueAt(schedule: TaskSchedule, now: Date, createdAt?: string): Date | null {
  if (schedule.nextRunAt) {
    const due = new Date(schedule.nextRunAt);
    return Number.isNaN(due.getTime()) ? null : due;
  }
  if (schedule.kind === "once") {
    if (!schedule.runAt) return null;
    const due = new Date(civilToIso(schedule.runAt, schedule.timezone));
    return Number.isNaN(due.getTime()) ? null : due;
  }
  if (!schedule.cron) return null;
  const start = createdAt ? new Date(createdAt) : now;
  const from = Number.isNaN(start.getTime()) ? now : start;
  return nextCronOccurrence(schedule.cron, from, schedule.timezone, { inclusive: true });
}

export function isScheduleDue(schedule: TaskSchedule, now: Date, createdAt?: string): boolean {
  if (!schedule.enabled) return false;
  const due = resolveDueAt(schedule, now, createdAt);
  return due !== null && due.getTime() <= now.getTime();
}

export function isTaskDue(task: Task, now: Date): boolean {
  if (task.kind !== "scheduled") return false;
  if (task.status !== "scheduled") return false;
  if (!task.schedule) return false;
  return isScheduleDue(task.schedule, now, task.createdAt);
}

/** 把周期任务的下次运行排到 now 之后；一次性任务则关闭自动触发。 */
export function advanceSchedule(schedule: TaskSchedule, now: Date): TaskSchedule {
  if (schedule.kind === "once") {
    return { ...schedule, enabled: false, nextRunAt: undefined };
  }
  if (!schedule.cron) return { ...schedule, nextRunAt: undefined };
  const next = nextCronOccurrence(schedule.cron, now, schedule.timezone, { inclusive: false });
  return {
    ...schedule,
    nextRunAt: next ? formatIso(next, schedule.timezone) : undefined,
  };
}

export function cronClockLabel(cron: string | undefined): string | undefined {
  if (!cron) return undefined;
  try {
    const parsed = parseCron(cron);
    if (parsed.hours.size === 1 && parsed.minutes.size === 1 && looksDaily(parsed)) {
      const hour = [...parsed.hours][0]!;
      const minute = [...parsed.minutes][0]!;
      return `${pad(hour)}:${pad(minute)}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function formatTaskScheduleLabel(
  schedule: TaskSchedule | undefined,
  now = new Date(),
): string | undefined {
  if (!schedule) return undefined;
  const tz = schedule.timezone || "Asia/Shanghai";
  const when = schedule.nextRunAt ?? (schedule.kind === "once" ? schedule.runAt : undefined);
  const whenText = when ? formatWhenZh(when, tz, now) : "";
  if (schedule.kind === "cron") {
    const clock = cronClockLabel(schedule.cron);
    const head = clock ? `每天 ${clock}` : schedule.cron ? `按周期 ${schedule.cron}` : "按周期";
    return whenText ? `${head}，下次 ${whenText}` : head;
  }
  return whenText ? `一次，${whenText}` : "一次";
}

export function nextCronOccurrence(
  cron: string,
  from: Date,
  timeZone: string,
  options: { inclusive?: boolean } = {},
): Date | null {
  const parsed = parseCron(cron);
  const aligned = startAligned(from, options.inclusive === true, parsed.hasSeconds);
  const limit = aligned.getTime() + 366 * 24 * 60 * 60 * 1000;
  const stepMs = parsed.hasSeconds ? 1000 : 60_000;
  for (let ts = aligned.getTime(); ts <= limit; ts += stepMs) {
    const instant = new Date(ts);
    if (cronMatches(parsed, instant, timeZone)) return instant;
  }
  return null;
}

function looksDaily(parsed: ParsedCron): boolean {
  if (parsed.domRestricted || parsed.dowRestricted) return false;
  if (parsed.months.size !== 12) return false;
  return true;
}

function cronMatches(parsed: ParsedCron, instant: Date, timeZone: string): boolean {
  const parts = civilParts(instant, timeZone);
  if (parsed.hasSeconds && parsed.seconds && !parsed.seconds.has(parts.second)) return false;
  if (!parsed.hasSeconds && parts.second !== 0) return false;
  if (!parsed.minutes.has(parts.minute)) return false;
  if (!parsed.hours.has(parts.hour)) return false;
  if (!parsed.months.has(parts.month)) return false;
  const domHit = parsed.daysOfMonth.has(parts.day);
  const dowHit = parsed.daysOfWeek.has(parts.weekday);
  if (parsed.domRestricted && parsed.dowRestricted) return domHit || dowHit;
  if (parsed.domRestricted) return domHit;
  if (parsed.dowRestricted) return dowHit;
  return true;
}

function civilParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const weekdayName = get("weekday").slice(0, 3).toLowerCase();
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[weekdayName] ?? 0,
  };
}

function parseField(
  expr: string,
  min: number,
  max: number,
  names: Record<string, number>,
  options: { sundaySeven?: boolean } = {},
): Set<number> {
  const out = new Set<number>();
  for (const raw of expr.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) throw new ScheduleError("cron 字段为空");
    const [rangePart, stepPart] = token.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new ScheduleError(`cron 步长无效：${token}`);
    let start = min;
    let end = max;
    if (rangePart !== "*") {
      const bounds = (rangePart ?? "").split("-");
      start = parseNameOrNumber(bounds[0]!, min, max, names, options);
      end = bounds.length > 1 ? parseNameOrNumber(bounds[1]!, min, max, names, options) : start;
      if (end < start) throw new ScheduleError(`cron 范围无效：${token}`);
    }
    for (let value = start; value <= end; value += step) out.add(value);
  }
  if (options.sundaySeven && out.has(7)) {
    out.add(0);
    out.delete(7);
  }
  return out;
}

function parseNameOrNumber(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number>,
  options: { sundaySeven?: boolean },
): number {
  const named = names[raw];
  if (named != null) return named;
  const value = Number(raw);
  const ceiling = options.sundaySeven ? Math.max(max, 7) : max;
  if (!Number.isInteger(value) || value < min || value > ceiling) {
    throw new ScheduleError(`cron 值超出范围：${raw}`);
  }
  return value;
}

function startAligned(from: Date, inclusive: boolean, hasSeconds: boolean): Date {
  if (hasSeconds) {
    return inclusive ? floorTo(from, 1000) : ceilTo(new Date(from.getTime() + 1), 1000);
  }
  return inclusive ? floorTo(from, 60_000) : ceilTo(new Date(from.getTime() + 1), 60_000);
}

function floorTo(date: Date, unit: number): Date {
  const ms = date.getTime();
  return new Date(ms - (ms % unit));
}

function ceilTo(date: Date, unit: number): Date {
  const ms = date.getTime();
  const rem = ms % unit;
  return rem === 0 ? date : new Date(ms + (unit - rem));
}

function formatWhenZh(iso: string, timeZone: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hour = pad(Number(part(date, timeZone, "hour")));
  const minute = pad(Number(part(date, timeZone, "minute")));
  const clock = `${hour}:${minute}`;
  const stamp = dateStamp(date, timeZone);
  const today = dateStamp(now, timeZone);
  const tomorrow = dateStamp(new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone);
  if (stamp === today) return `今天 ${clock}`;
  if (stamp === tomorrow) return `明天 ${clock}`;
  const month = Number(part(date, timeZone, "month"));
  const day = Number(part(date, timeZone, "day"));
  return `${month}月${day}日 ${clock}`;
}

function dateStamp(date: Date, timeZone: string): string {
  return `${part(date, timeZone, "year")}-${part(date, timeZone, "month")}-${part(date, timeZone, "day")}`;
}

function part(date: Date, timeZone: string, type: "year" | "month" | "day" | "hour" | "minute"): string {
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

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
