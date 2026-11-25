import { describe, expect, it } from "vitest";
import { taskSchema, type Task } from "@huoye/schema";
import {
  advanceSchedule,
  formatTaskScheduleLabel,
  isTaskDue,
  nextCronOccurrence,
  normalizeSchedule,
  parseCron,
} from "./schedule";

const TZ = "Asia/Shanghai";

function task(partial: Partial<Task> & Pick<Task, "schedule">): Task {
  return taskSchema.parse({
    id: "tsk_sched_1",
    kind: "scheduled",
    title: "到点整理",
    instruction: "到点整理一下今天的待办",
    status: "scheduled",
    confirmationIds: [],
    createdAt: "2026-11-23T10:00:00+08:00",
    updatedAt: "2026-11-23T10:00:00+08:00",
    ...partial,
  });
}

describe("@huoye/core schedule", () => {
  it("parses five-field cron and finds the next hour in Asia/Shanghai", () => {
    const parsed = parseCron("0 21 * * *");
    expect(parsed.hours.has(21)).toBe(true);
    expect(parsed.minutes.has(0)).toBe(true);
    const next = nextCronOccurrence("0 21 * * *", new Date("2026-11-23T10:00:00+08:00"), TZ, {
      inclusive: true,
    });
    expect(next?.toISOString()).toBe(new Date("2026-11-23T21:00:00+08:00").toISOString());
  });

  it("treats a task due in the past as due, and catch-up advances a cron past now", () => {
    const once = task({
      schedule: {
        kind: "once",
        runAt: "2026-11-23T08:00:00+08:00",
        timezone: TZ,
        enabled: true,
        nextRunAt: "2026-11-23T08:00:00+08:00",
      },
    });
    const now = new Date("2026-11-23T12:45:00+08:00");
    expect(isTaskDue(once, now)).toBe(true);

    const cron = normalizeSchedule(
      { kind: "cron", cron: "0 8 * * *", timezone: TZ, enabled: true },
      { now: new Date("2026-11-22T09:00:00+08:00"), timezone: TZ },
    );
    // Created yesterday after the 08:00 slot, so next was this morning 08:00 — already missed by 12:45.
    expect(cron.nextRunAt).toBe("2026-11-23T08:00:00+08:00");
    expect(
      isTaskDue(
        task({
          createdAt: "2026-11-22T09:00:00+08:00",
          schedule: cron,
        }),
        now,
      ),
    ).toBe(true);
    const advanced = advanceSchedule(cron, now);
    expect(advanced.nextRunAt).toBe("2026-11-24T08:00:00+08:00");
  });

  it("does not mark a future daily task due, and labels the next run in Chinese", () => {
    const schedule = normalizeSchedule(
      { kind: "cron", cron: "30 21 * * *", timezone: TZ, enabled: true },
      { now: new Date("2026-11-23T12:45:00+08:00"), timezone: TZ },
    );
    expect(schedule.nextRunAt).toBe("2026-11-23T21:30:00+08:00");
    expect(
      isTaskDue(
        task({ schedule }),
        new Date("2026-11-23T12:45:00+08:00"),
      ),
    ).toBe(false);
    const label = formatTaskScheduleLabel(schedule, new Date("2026-11-23T12:45:00+08:00"));
    expect(label).toContain("每天 21:30");
    expect(label).toContain("今天 21:30");
  });

  it("normalizes a datetime-local once time into an offset ISO and keeps it due if already past", () => {
    const schedule = normalizeSchedule(
      { kind: "once", runAt: "2026-11-23T12:00", timezone: TZ, enabled: true },
      { now: new Date("2026-11-23T12:45:00+08:00"), timezone: TZ },
    );
    expect(schedule.runAt).toBe("2026-11-23T12:00:00+08:00");
    expect(schedule.nextRunAt).toBe("2026-11-23T12:00:00+08:00");
    expect(isTaskDue(task({ schedule }), new Date("2026-11-23T12:45:00+08:00"))).toBe(true);
    expect(advanceSchedule(schedule, new Date("2026-11-23T12:45:00+08:00")).enabled).toBe(false);
  });

  it("keeps a cancelled or disabled task from firing", () => {
    const schedule = {
      kind: "once" as const,
      runAt: "2026-11-23T08:00:00+08:00",
      timezone: TZ,
      enabled: true,
      nextRunAt: "2026-11-23T08:00:00+08:00",
    };
    const now = new Date("2026-11-23T12:45:00+08:00");
    expect(isTaskDue(task({ status: "cancelled", schedule }), now)).toBe(false);
    expect(isTaskDue(task({ schedule: { ...schedule, enabled: false } }), now)).toBe(false);
    expect(isTaskDue(task({ kind: "on_demand", status: "draft", schedule }), now)).toBe(false);
  });
});
