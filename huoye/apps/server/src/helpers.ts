import { CORE_ABOUT_YOU_FILES } from "@huoye/config";
import { summarizeHealthNote } from "@huoye/memory";
import type { Workspace } from "./workspace";

export function dateInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function summarize(text: string): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "已跑完一遍。";
  const first = flat.split(/[。！？\n]/).filter(Boolean)[0] ?? flat;
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}

export function unitCost(
  settings: { providers: Array<{ id: string; inputUsdPer1M?: number; outputUsdPer1M?: number }> },
  providerId: string,
): number | undefined {
  const provider = settings.providers.find((p) => p.id === providerId);
  if (!provider) return undefined;
  if (provider.inputUsdPer1M == null && provider.outputUsdPer1M == null) return undefined;
  const input = provider.inputUsdPer1M ?? 0;
  const output = provider.outputUsdPer1M ?? 0;
  return (input + output) / 2;
}

export function readAboutYouFiles(
  workspace: Workspace,
): Array<{ relativePath: string; title: string; content: string }> {
  const out: Array<{ relativePath: string; title: string; content: string }> = [];
  for (const relative of CORE_ABOUT_YOU_FILES) {
    try {
      const file = workspace.memory.readFile(relative);
      out.push({ relativePath: relative, title: file.title, content: file.content });
    } catch {
      out.push({ relativePath: relative, title: relative, content: "" });
    }
  }
  return out;
}

export function readDiaryFacts(workspace: Workspace, timeZone: string, now = new Date()): string[] {
  const relative = `diaries/${dateInZone(now, timeZone)}.md`;
  let content: string;
  try {
    content = workspace.memory.readFile(relative).content;
  } catch {
    return [];
  }
  const facts: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*[-*]\s+(.+)$/);
    if (!match) continue;
    const text = match[1].trim();
    if (!text || text.startsWith("出处：")) continue;
    facts.push(text);
  }
  return facts;
}

export function briefExists(workspace: Workspace, date: string, slot: "morning" | "evening"): boolean {
  try {
    workspace.memory.readFile(`briefs/${date}-${slot}.md`);
    return true;
  } catch {
    return false;
  }
}

export function readHealthFacts(workspace: Workspace, timeZone: string, now = new Date()): string[] {
  const file = workspace.memory.readHealthNote(dateInZone(now, timeZone));
  if (!file) return [];
  return summarizeHealthNote(file.content);
}
