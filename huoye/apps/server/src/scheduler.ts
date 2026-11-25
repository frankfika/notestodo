import { isTaskDue, ScheduleError } from "@huoye/core";
import { listTasks, reapStaleRunningTasks } from "./records";
import { executeTaskRun } from "./run-task";
import { dueAnchorSlot, generateAndSaveBrief } from "./generate-brief";
import { evaluateProactivePause, pushBriefToChat } from "./proactive";
import type { Workspace } from "./workspace";

export const DEFAULT_SCHEDULER_INTERVAL_MS = 10_000;

export interface SchedulerHooks {
  workspace: Workspace;
  now?: () => Date;
  timezone?: () => string;
}

export async function tickDueWork(hooks: SchedulerHooks, injectedNow?: Date): Promise<{
  ranTaskIds: string[];
  briefSlot?: "morning" | "evening";
  /** 简报有没有被推到主对话里。 */
  briefPushed?: boolean;
}> {
  const { workspace } = hooks;
  const now = injectedNow ?? hooks.now?.() ?? new Date();
  const timeZone = hooks.timezone?.() ?? workspace.readSettings().timezone ?? "Asia/Shanghai";
  reapStaleRunningTasks(workspace.db, timeZone, { now });

  const ranTaskIds: string[] = [];
  const due = listTasks(workspace.db).filter((task) => isTaskDue(task, now));
  for (const task of due) {
    const latest = listTasks(workspace.db).find((item) => item.id === task.id);
    if (!latest || !isTaskDue(latest, now)) continue;
    try {
      await executeTaskRun({
        workspace,
        taskId: task.id,
        timezone: task.schedule?.timezone || timeZone,
        trigger: "schedule",
        now,
      });
      ranTaskIds.push(task.id);
    } catch (error) {
      if (error instanceof ScheduleError) continue;
      // 单个任务失败不打断其余到期项
    }
  }

  const settings = workspace.readSettings();
  const proactivity = settings.proactivity ?? "off";
  let briefSlot: "morning" | "evening" | undefined;
  let briefPushed: boolean | undefined;
  // off 时彻底安静：不整理简报，也不写聊天。
  if (proactivity !== "off") {
    // 先看是不是该暂停（连着几天没读）；暂停了就不再整理新的简报。
    const state = evaluateProactivePause(workspace, now, timeZone);
    const slot = dueAnchorSlot(workspace, now, timeZone, proactivity);
    if (slot && !state.paused) {
      const brief = await generateAndSaveBrief({ workspace, now, timeZone });
      const pushed = pushBriefToChat(
        workspace,
        {
          text: brief.text,
          path: brief.path,
          slot: brief.slot,
          label: brief.label,
          nextAnchor: brief.nextAnchor,
        },
        now,
        timeZone,
      );
      briefSlot = slot;
      briefPushed = pushed.pushed;
    }
  }
  return { ranTaskIds, briefSlot, briefPushed };
}

export function startScheduler(
  hooks: SchedulerHooks,
  options: { intervalMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS;
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tickDueWork(hooks);
    } catch {
      // 调度器保持安静，下一轮再试
    } finally {
      ticking = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
