import {
  currentBriefSlot,
  EVENING_HOUR,
  MORNING_HOUR,
  nextAnchor,
  selectBriefDiaryFacts,
  summarizeAboutYou,
  synthesizeBrief,
} from "@huoye/core";
import { briefRelativePath } from "@huoye/memory";
import { recordUsageEvent } from "@huoye/metering";
import { briefTimeOfDayLabel, briefTimeOfDayTitle, formatIso, localHourInZone } from "@huoye/schema";
import { listTasks, reapStaleRunningTasks } from "./records";
import { briefExists, dateInZone, readAboutYouFiles, readDiaryFacts, readHealthFacts, unitCost } from "./helpers";
import type { Workspace } from "./workspace";

export interface BriefPayload {
  text: string;
  generatedAt: string | null;
  slot: "morning" | "evening";
  source?: "model" | "local";
  path?: string;
  label: string;
  nextAnchor: { slot: "morning" | "evening"; hour: number; label: string };
  fallbackMessage?: string;
}

export async function generateAndSaveBrief(input: {
  workspace: Workspace;
  now?: Date;
  timeZone?: string;
}): Promise<BriefPayload> {
  const { workspace } = input;
  const settings = workspace.readSettings();
  const timeZone = input.timeZone ?? settings.timezone ?? "Asia/Shanghai";
  const now = input.now ?? new Date();
  const aboutYou = readAboutYouFiles(workspace);
  const facts = summarizeAboutYou(aboutYou.map((f) => ({ title: f.title, content: f.content })));
  reapStaleRunningTasks(workspace.db, timeZone, { now });
  const tasks = listTasks(workspace.db).filter(
    (t) => t.status !== "cancelled" && t.status !== "completed" && t.status !== "failed",
  );
  const diaryFacts = selectBriefDiaryFacts(readDiaryFacts(workspace, timeZone, now));
  const healthFacts = readHealthFacts(workspace, timeZone, now);
  let provider;
  let resolveFallback: string | undefined;
  try {
    provider = workspace.resolveProvider();
  } catch (error) {
    resolveFallback =
      error instanceof Error && error.message.trim()
        ? error.message
        : "这个供应商还没有配置接口地址或密钥，已改用本地档案整理一版。";
  }
  const result = await synthesizeBrief({
    now,
    timeZone,
    displayName: settings.displayName,
    facts,
    openTaskTitles: tasks.map((t) => t.title),
    diaryFacts,
    healthFacts,
    provider,
  });
  const generatedAt = formatIso(now, timeZone);
  const label = briefTimeOfDayLabel(localHourInZone(now, timeZone));
  if (result.usedModel && provider) {
    recordUsageEvent(
      workspace.db,
      {
        provider: provider.id,
        model: provider.modelId,
        purpose: "brief",
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        source: "byok",
        unitCostInUsd: unitCost(settings, provider.id),
      },
      { timezone: timeZone },
    );
  }
  const saved = workspace.memory.writeBrief({
    date: dateInZone(now, timeZone),
    slot: result.slot,
    text: result.text,
    generatedAt,
    source: result.source,
    label,
  });
  workspace.audit({
    actor: "agent",
    type: "brief.generated",
    summary: `生成${label}简报 ${saved.relativePath}`,
    refs: [saved.relativePath],
  });
  return {
    text: result.text,
    generatedAt,
    slot: result.slot,
    source: result.source,
    path: saved.relativePath,
    label: briefTimeOfDayTitle(localHourInZone(now, timeZone)),
    nextAnchor: nextAnchor(now, timeZone),
    fallbackMessage: result.fallbackMessage ?? resolveFallback,
  };
}

export function latestBriefPayload(workspace: Workspace, now = new Date()): BriefPayload {
  const settings = workspace.readSettings();
  const timeZone = settings.timezone || "Asia/Shanghai";
  const slot = currentBriefSlot(now, timeZone);
  const latest = workspace.memory.readLatestBrief(now, slot);
  if (!latest) {
    return {
      text: "",
      generatedAt: null,
      slot,
      path: undefined,
      label: briefTimeOfDayTitle(localHourInZone(now, timeZone)),
      nextAnchor: nextAnchor(now, timeZone),
    };
  }
  const generated = latest.generatedAt ? new Date(latest.generatedAt) : now;
  const hour = Number.isNaN(generated.getTime()) ? localHourInZone(now, timeZone) : localHourInZone(generated, timeZone);
  return {
    text: latest.text,
    generatedAt: latest.generatedAt,
    slot: latest.slot,
    path: latest.path,
    label: briefTimeOfDayTitle(hour),
    nextAnchor: nextAnchor(now, timeZone),
  };
}

/**
 * 主动性不是 off 时，到了早上 08:00 / 晚上 21:00 锚点（或服务器晚到、当天这份还没有）就自动整理一版。
 * 同一天同一槽已有简报则不再覆盖。
 */
export function dueAnchorSlot(
  workspace: Workspace,
  now: Date,
  timeZone: string,
  proactivity: string,
): "morning" | "evening" | null {
  if (proactivity === "off") return null;
  const hour = localHourInZone(now, timeZone);
  const date = dateInZone(now, timeZone);
  if (hour >= EVENING_HOUR && !briefExists(workspace, date, "evening")) return "evening";
  if (hour >= MORNING_HOUR && hour < EVENING_HOUR && !briefExists(workspace, date, "morning")) return "morning";
  return null;
}

export function briefPathFor(date: string, slot: "morning" | "evening"): string {
  return briefRelativePath(date, slot);
}
