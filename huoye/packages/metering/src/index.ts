import {
  ID_PREFIXES,
  nowIso,
  usageEventSchema,
  type UsageEvent,
  type UsagePurpose,
  type UsageSummary,
} from "@huoye/schema";
import { newId, type HuoyeDb, all, run } from "@huoye/core";
import { assertNoSecret, redactSecrets } from "./redact";

export { redactSecrets, assertNoSecret } from "./redact";

interface UsageRow {
  id: string;
  at: string;
  provider: string;
  model: string;
  purpose: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  unit_cost_in_usd: number | null;
  estimated_cost_usd: number | null;
  source: string;
  chat_id: string | null;
  task_id: string | null;
}

export function recordUsageEvent(
  db: HuoyeDb,
  input: Omit<UsageEvent, "id" | "at" | "totalTokens" | "estimatedCostUsd"> & {
    at?: string;
    totalTokens?: number;
    estimatedCostUsd?: number;
  },
  options?: { timezone?: string },
): UsageEvent {
  const inputTokens = input.inputTokens;
  const outputTokens = input.outputTokens;
  const totalTokens = input.totalTokens ?? inputTokens + outputTokens;
  const estimatedCostUsd =
    input.estimatedCostUsd ??
    (input.unitCostInUsd !== undefined
      ? (totalTokens / 1_000_000) * input.unitCostInUsd
      : undefined);
  const event = usageEventSchema.parse({
    id: newId(ID_PREFIXES.usage),
    at: input.at ?? nowIso(options?.timezone ?? "Asia/Shanghai"),
    provider: input.provider,
    model: input.model,
    purpose: input.purpose,
    inputTokens,
    outputTokens,
    totalTokens,
    unitCostInUsd: input.unitCostInUsd,
    estimatedCostUsd,
    source: input.source,
    chatId: input.chatId,
    taskId: input.taskId,
  });
  const sanitized = redactSecrets(event);
  assertNoSecret(JSON.stringify(sanitized), collectSecrets(input));
  run(
    db.raw,
    `INSERT INTO usage_events (
      id, at, provider, model, purpose, input_tokens, output_tokens, total_tokens,
      unit_cost_in_usd, estimated_cost_usd, source, chat_id, task_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.at,
    event.provider,
    event.model,
    event.purpose,
    event.inputTokens,
    event.outputTokens,
    event.totalTokens,
    event.unitCostInUsd ?? null,
    event.estimatedCostUsd ?? null,
    event.source,
    event.chatId ?? null,
    event.taskId ?? null,
  );
  return event;
}

export function listUsageEvents(db: HuoyeDb, limit = 100): UsageEvent[] {
  const rows = all<UsageRow>(db.raw, "SELECT * FROM usage_events ORDER BY at DESC LIMIT ?", limit);
  return rows.map(fromRow);
}

export function summarizeUsage(db: HuoyeDb, timezone = "Asia/Shanghai"): UsageSummary {
  const events = listUsageEvents(db, 10_000);
  const now = new Date();
  const todayStamp = dateStamp(now, timezone);
  const monthPrefix = todayStamp.slice(0, 7);
  const todayEvents = events.filter((e) => dateStamp(new Date(e.at), timezone) === todayStamp);
  const monthEvents = events.filter((e) => dateStamp(new Date(e.at), timezone).startsWith(monthPrefix));
  const byPurposeMap = new Map<UsagePurpose, UsageEvent[]>();
  const byModelMap = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const purposeList = byPurposeMap.get(event.purpose) ?? [];
    purposeList.push(event);
    byPurposeMap.set(event.purpose, purposeList);
    const key = `${event.provider}::${event.model}`;
    const modelList = byModelMap.get(key) ?? [];
    modelList.push(event);
    byModelMap.set(key, modelList);
  }
  return {
    today: bucket(todayEvents),
    month: bucket(monthEvents),
    byPurpose: [...byPurposeMap.entries()].map(([purpose, list]) => ({ purpose, ...bucket(list) })),
    byModel: [...byModelMap.entries()].map(([key, list]) => {
      const [provider, model] = key.split("::") as [string, string];
      return { provider, model, ...bucket(list) };
    }),
  };
}

function bucket(events: UsageEvent[]) {
  const inputTokens = events.reduce((s, e) => s + e.inputTokens, 0);
  const outputTokens = events.reduce((s, e) => s + e.outputTokens, 0);
  const totalTokens = events.reduce((s, e) => s + e.totalTokens, 0);
  const costValues = events
    .map((e) => e.estimatedCostUsd)
    .filter((n): n is number => typeof n === "number");
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd: costValues.length ? costValues.reduce((s, n) => s + n, 0) : undefined,
    count: events.length,
  };
}

function fromRow(row: UsageRow): UsageEvent {
  return usageEventSchema.parse({
    id: row.id,
    at: row.at,
    provider: row.provider,
    model: row.model,
    purpose: row.purpose,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    unitCostInUsd: row.unit_cost_in_usd ?? undefined,
    estimatedCostUsd: row.estimated_cost_usd ?? undefined,
    source: row.source,
    chatId: row.chat_id ?? undefined,
    taskId: row.task_id ?? undefined,
  });
}

function dateStamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function collectSecrets(input: object): string[] {
  const secrets: string[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && /key|secret|token|password/i.test(k)) secrets.push(v);
      else visit(v);
    }
  };
  visit(input);
  return secrets;
}
