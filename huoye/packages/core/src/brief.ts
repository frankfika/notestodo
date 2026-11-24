import { timeOfDayGreeting } from "@huoye/schema";
import { modelFallbackMessage } from "./model-error";

export { modelFallbackMessage };

/**
 * 活页自己的锚点与简报生成。早晨 08:00，晚上 21:00。
 */

export const MORNING_HOUR = 8;
export const EVENING_HOUR = 21;

export type BriefSlot = "morning" | "evening";

export type BriefSource = "model" | "local";

export interface BriefResult {
  text: string;
  slot: BriefSlot;
  source: BriefSource;
  usedModel: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** 配置了真实模型但没写出来时，诚实说明已改用本地档案。 */
  fallbackMessage?: string;
}

export interface BriefProvider {
  type: string;
  complete(
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

export function localHour(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = parts.find((part) => part.type === "hour")?.value ?? "0";
  return Number(value);
}

export function currentBriefSlot(now: Date, timeZone: string): BriefSlot {
  const hour = localHour(now, timeZone);
  return hour >= MORNING_HOUR && hour < EVENING_HOUR ? "morning" : "evening";
}

export function nextAnchor(
  now: Date,
  timeZone: string,
): { slot: BriefSlot; hour: number; label: string } {
  const hour = localHour(now, timeZone);
  if (hour < MORNING_HOUR) {
    return { slot: "morning", hour: MORNING_HOUR, label: `今天早上 ${pad(MORNING_HOUR)}:00` };
  }
  if (hour < EVENING_HOUR) {
    return { slot: "evening", hour: EVENING_HOUR, label: `今晚 ${pad(EVENING_HOUR)}:00` };
  }
  return { slot: "morning", hour: MORNING_HOUR, label: `明天早上 ${pad(MORNING_HOUR)}:00` };
}

export function dateHeading(now: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(now);
  const monthParts = new Intl.DateTimeFormat("en-CA", { timeZone, month: "2-digit" }).formatToParts(now);
  const dayParts = new Intl.DateTimeFormat("en-CA", { timeZone, day: "2-digit" }).formatToParts(now);
  const month = monthParts.find((part) => part.type === "month")?.value ?? "";
  const day = dayParts.find((part) => part.type === "day")?.value ?? "";
  return `${weekday}，${Number(month)}月${Number(day)}日`;
}

/** 只抽已填写的列表项，跳过空值和教学段落。 */
export function summarizeAboutYou(files: Array<{ title: string; content: string }>): string[] {
  const out: string[] = [];
  for (const file of files) {
    const body = stripFrontmatter(file.content);
    for (const line of body.split("\n")) {
      const match = line.match(/^\s*[-*]\s+([^：:]+)[：:]\s*(.*)$/);
      if (!match) continue;
      const field = match[1].trim();
      const value = match[2].trim();
      if (!field || !value) continue;
      if (/^(待补充|无|none|n\/a|tbd)$/i.test(value)) continue;
      out.push(`${field}：${value}`);
    }
  }
  return out;
}


/** 简报里的「今天记下了」只保留有用的事实，不把聊天原文或任务日志缝上去。 */
export function selectBriefDiaryFacts(raw: string[]): string[] {
  const cleaned: string[] = [];
  for (const item of raw) {
    const text = (item ?? "").replace(/[。！？.]+$/u, "").trim();
    if (!text) continue;
    if (text.startsWith("出处：")) continue;
    if (/(拟一条|先别发出去|先不要发|不要发出去|先不发)/.test(text)) continue;
    if (/^任务[「"].+已处理/.test(text)) continue;
    if (/我记下了[：:]「/.test(text) || /我记下了：「/.test(text)) continue;
    if (/我看到了你刚说的那一段/.test(text)) continue;
    cleaned.push(text);
  }
  // 从新到旧保留互不重复的事实，避免把「晚上还是不喜欢被打断」这类同义句再缝上去。
  const unique: string[] = [];
  const folded: string[] = [];
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const item = cleaned[i]!;
    const key = foldDiaryFact(item);
    if (!key) continue;
    const index = folded.findIndex(
      (existing) => existing === key || existing.includes(key) || key.includes(existing),
    );
    if (index >= 0) {
      if (key.length > folded[index]!.length) {
        folded[index] = key;
        unique[index] = item;
      }
      continue;
    }
    folded.push(key);
    unique.push(item);
  }
  const chronological: string[] = [];
  for (let i = unique.length - 1; i >= 0; i--) chronological.push(unique[i]!);
  return chronological.slice(-3);
}

function foldDiaryFact(text: string): string {
  return text.replace(/还是|其实|的确|确实|挺|比较/g, "").replace(/\s+/g, "").replace(/[。！？.]+$/u, "");
}

export function buildLocalBrief(input: {
  now?: Date;
  timeZone: string;
  displayName?: string;
  facts: string[];
  openTaskTitles: string[];
  diaryFacts?: string[];
  healthFacts?: string[];
}): string {
  const now = input.now ?? new Date();
  const blocks: string[] = [dateHeading(now, input.timeZone)];

  const name = (input.displayName ?? "").trim();
  const greeting = timeOfDayGreeting(localHour(now, input.timeZone));
  blocks.push(name && name !== "你" ? `${name}，${greeting}。` : `${greeting}。`);

  const phrases = factPhrases(input.facts, name);
  if (phrases.length) {
    blocks.push(`档案里记下的是：${phrases.join("，")}。`);
  } else if (input.facts.length) {
    blocks.push("档案里记着的基本信息还不多，慢慢补就好。");
  } else {
    blocks.push("档案里还没有记下什么。可以说说你是谁、在做什么。");
  }

  const titles = input.openTaskTitles.filter(Boolean);
  if (titles.length) {
    blocks.push(`手头有 ${titles.length} 件未完成的事：${titles.slice(0, 3).join("、")}。`);
  } else {
    blocks.push("手头还没有未完成的任务。如果今天有要跟进的事，直接告诉我，我会记下来。");
  }

  const diary = selectBriefDiaryFacts(input.diaryFacts ?? []);
  if (diary.length) {
    blocks.push(`今天记下了：${joinClauses(diary)}。`);
  }

  const health = selectHealthFacts(input.healthFacts ?? []);
  if (health.length) {
    blocks.push(`今天的健康记录里写了：${joinClauses(health)}。`);
  }

  return blocks.join("\n\n");
}


export async function synthesizeBrief(input: {
  now?: Date;
  timeZone: string;
  displayName?: string;
  facts: string[];
  openTaskTitles: string[];
  diaryFacts?: string[];
  healthFacts?: string[];
  provider?: BriefProvider;
}): Promise<BriefResult> {
  const now = input.now ?? new Date();
  const slot = currentBriefSlot(now, input.timeZone);
  if (!input.provider || input.provider.type === "mock") {
    return {
      text: buildLocalBrief({ ...input, now }),
      slot,
      source: "local",
      usedModel: false,
    };
  }

  const hour = localHour(now, input.timeZone);
  const greeting = timeOfDayGreeting(hour);
  const health = selectHealthFacts(input.healthFacts ?? []);
  const prompt = [
    "写一段中文短简报，3 到 5 句，像一个安静的本地助手写给自己看。",
    `日期：${dateHeading(now, input.timeZone)}`,
    `问候请用「${greeting}」，不要写成其他时段。`,
    `称呼：${(input.displayName ?? "").trim() || "无"}`,
    `已知事实：${input.facts.length ? input.facts.join("；") : "无"}`,
    `未完成任务：${input.openTaskTitles.length ? input.openTaskTitles.join("；") : "无"}`,
    `今日日记：${selectBriefDiaryFacts(input.diaryFacts ?? []).join("；") || "无"}`,
    `今日健康（请写进简报，优先用最新的一笔）：${health.length ? health.join("；") : "无"}`,
    "不要出现标题、列表符号或表情，不要复述本段说明。不要原样粘贴文件内容。",
  ].join("\n");

  try {
    const completion = await input.provider.complete([
      { role: "system", content: "你只输出简报正文，不要解释。" },
      { role: "user", content: prompt },
    ]);
    const text = completion.text.trim();
    if (!text) throw new Error("空回复");
    return {
      text,
      slot,
      source: "model",
      usedModel: true,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
    };
  } catch (error) {
    return {
      text: buildLocalBrief({ ...input, now }),
      slot,
      source: "local",
      usedModel: false,
      fallbackMessage: modelFallbackMessage(error),
    };
  }
}


const HEALTH_FACT_FIELDS = ["睡眠", "活动", "心情", "备注"] as const;

/** 简报里的健康一句只保留条目；同一字段多次出现时，用最新的一笔。 */
export function selectHealthFacts(raw: string[]): string[] {
  const cleaned: string[] = [];
  for (const item of raw) {
    const text = (item ?? "").replace(/[。！？.]+$/u, "").trim();
    if (!text) continue;
    if (text.startsWith("出处：") || text.startsWith("出处:")) continue;
    cleaned.push(text);
  }
  const latest = new Map<string, string>();
  const extras: string[] = [];
  for (const item of cleaned) {
    const field = item.match(/^([^：:]+)[：:]/)?.[1]?.trim() ?? "";
    if ((HEALTH_FACT_FIELDS as readonly string[]).includes(field)) latest.set(field, item);
    else extras.push(item);
  }
  const preferred = HEALTH_FACT_FIELDS.map((field) => latest.get(field)).filter((item): item is string => Boolean(item));
  return [...preferred, ...extras].slice(0, 4);
}

function factPhrases(facts: string[], displayName: string): string[] {
  const phrases: string[] = [];
  for (const fact of facts) {
    const [rawField, ...rest] = fact.split("：");
    const field = (rawField ?? "").trim();
    const value = rest.join("：").trim();
    if (!field || !value) continue;
    if (field === "时区" || field === "常用语言") continue;
    if (field === "称呼") {
      if (value && value !== displayName) phrases.push(`你叫${value}`);
      continue;
    }
    if (field === "所在城市") {
      phrases.push(`你在${value}`);
      continue;
    }
    if (field === "正在做的事") {
      phrases.push(`工作围着${value}转`);
      continue;
    }
    if (field === "作息" || /[。！？]$/.test(value) || value.length >= 8) {
      phrases.push(value.replace(/[。！？]+$/, ""));
      continue;
    }
    phrases.push(`${field}是${value}`);
  }
  return phrases;
}

function stripFrontmatter(content: string): string {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, "");
  if (!withoutComments.startsWith("---")) return withoutComments;
  const lines = withoutComments.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return withoutComments;
}

function joinClauses(items: string[]): string {
  return items.map((item) => item.replace(/[。！？.]+$/u, "").trim()).filter(Boolean).join("；");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
