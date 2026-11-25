import { recordUsageEvent } from "@huoye/metering";
import { formatIso, type Task, type TaskRunEvent } from "@huoye/schema";
import { advanceSchedule, modelErrorMessage } from "@huoye/core";
import { addRunEvent, getTask, listRunEvents, saveTask } from "./records";
import { buildTaskPrompt } from "./prompt";
import { summarize, unitCost } from "./helpers";
import { pushTaskResultToChat } from "./proactive";
import type { Workspace } from "./workspace";

export class TaskRunError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "TaskRunError";
  }
}

export async function executeTaskRun(input: {
  workspace: Workspace;
  taskId: string;
  timezone: string;
  trigger: "manual" | "schedule";
  now?: Date;
}): Promise<{ task: Task; events: TaskRunEvent[] }> {
  const { workspace, taskId, timezone, trigger } = input;
  const now = input.now ?? new Date();
  const stamp = formatIso(now, timezone);
  const task = getTask(workspace.db, taskId);
  if (!task) throw new TaskRunError("找不到任务", 404);
  if (task.status === "cancelled") throw new TaskRunError("任务已取消");
  if (task.status === "running") throw new TaskRunError("任务正在运行");

  const started: Task = {
    ...task,
    status: "running",
    startedAt: stamp,
    updatedAt: stamp,
    errorMessage: undefined,
  };
  saveTask(workspace.db, started);
  addRunEvent(
    workspace.db,
    { taskId: task.id, type: "status", message: trigger === "schedule" ? "到点，开始运行" : "开始运行" },
    timezone,
  );

  const settings = workspace.readSettings();
  let reply = `已记下任务「${task.title}」。`;
  let status: "completed" | "failed" = "completed";
  let errorMessage: string | undefined;
  let diaryWritten = false;

  try {
    const provider = workspace.resolveProvider();
    const completion = await provider.complete(buildTaskPrompt(workspace, task), {
      assistantName: settings.assistantName,
    });
    reply = completion.text;
    if (provider.type !== "mock") {
      recordUsageEvent(
        workspace.db,
        {
          provider: provider.id,
          model: provider.modelId,
          purpose: trigger === "schedule" ? "scheduled_task" : "task",
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          source: "byok",
          unitCostInUsd: unitCost(settings, provider.id),
          taskId: task.id,
        },
        { timezone },
      );
    }
    addRunEvent(workspace.db, { taskId: task.id, type: "model", message: reply }, timezone);
    try {
      workspace.memory.appendDiary({
        fact: `任务「${task.title}」已处理：${summarize(reply)}`,
        sourceLabel: "来自任务",
        sourceRef: `task:${task.id}`,
        actor: "agent",
      });
      diaryWritten = true;
    } catch {
      // 日记写不进去也不影响任务终态
    }
  } catch (error) {
    status = "failed";
    const raw = error instanceof Error ? error.message : "";
    errorMessage =
      raw.includes("{") || raw.includes("模型接口请求失败") || raw.startsWith("模型这次没有写出来")
        ? modelErrorMessage(error)
        : raw.trim() || "运行失败";
    addRunEvent(workspace.db, { taskId: task.id, type: "log", message: errorMessage }, timezone);
  }

  const finished = finishTask({
    started,
    status,
    errorMessage,
    stamp,
    trigger,
    now,
  });
  saveTask(workspace.db, finished);
  addRunEvent(
    workspace.db,
    {
      taskId: task.id,
      type: "status",
      message:
        status === "completed"
          ? diaryWritten
            ? "已完成，并记到今天的日记。"
            : "已完成。"
          : "运行失败",
    },
    timezone,
  );

  // 到点跑的任务把结果回写到主对话；手动跑的不用打扰。
  if (trigger === "schedule") {
    try {
      pushTaskResultToChat(
        workspace,
        {
          title: task.title,
          ok: status === "completed",
          summary: status === "completed" ? summarize(reply) : errorMessage || "运行失败",
          taskId: task.id,
          chatId: task.chatId,
        },
        now,
        timezone,
      );
    } catch {
      // 回写失败不影响任务本身的终态。
    }
  }

  return { task: getTask(workspace.db, task.id) ?? finished, events: listRunEvents(workspace.db, task.id) };
}

function finishTask(input: {
  started: Task;
  status: "completed" | "failed";
  errorMessage?: string;
  stamp: string;
  trigger: "manual" | "schedule";
  now: Date;
}): Task {
  const { started, status, errorMessage, stamp, trigger, now } = input;
  const schedule = started.schedule;
  if (started.kind === "scheduled" && schedule?.kind === "cron") {
    const nextSchedule = trigger === "schedule" ? advanceSchedule(schedule, now) : schedule;
    return {
      ...started,
      status: "scheduled",
      schedule: nextSchedule,
      finishedAt: stamp,
      updatedAt: stamp,
      errorMessage,
    };
  }
  if (started.kind === "scheduled" && schedule?.kind === "once") {
    return {
      ...started,
      status,
      schedule: { ...schedule, enabled: false, nextRunAt: undefined },
      finishedAt: stamp,
      updatedAt: stamp,
      errorMessage,
    };
  }
  return {
    ...started,
    status,
    finishedAt: stamp,
    updatedAt: stamp,
    errorMessage,
  };
}
