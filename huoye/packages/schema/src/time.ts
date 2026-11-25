/** Format a Date as ISO 8601 with a numeric timezone offset (not Z). */
export function formatIso(date: Date, timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const rawOffset = get("timeZoneName") || "GMT+08:00";
  const offset = rawOffset.replace(/^GMT/i, "") || "+08:00";
  const normalized = offset === "Z" ? "+00:00" : offset;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${normalized}`;
}

export function nowIso(timeZone = "Asia/Shanghai", date?: Date): string {
  return formatIso(date ?? new Date(), timeZone);
}

/** 给界面看的本地时间，例如「11月23日 14:20」，不直接展示 ISO。 */
export function formatFriendlyLocalTime(date: Date, timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const month = String(Number(get("month")));
  const day = String(Number(get("day")));
  return `${month}月${day}日 ${get("hour")}:${get("minute")}`;
}


/** 按本地小时给出中文时段问候。11 点起算下午，和首页保持一致。 */
export function timeOfDayGreeting(hour: number): string {
  if (hour < 11) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/** 按本地小时给出简报时段标签，避免下午还写「早间简报」。 */
export function briefTimeOfDayLabel(hour: number): "早间" | "午间" | "下午" | "晚间" {
  if (hour < 11) return "早间";
  if (hour < 14) return "午间";
  if (hour < 18) return "下午";
  return "晚间";
}

export function briefTimeOfDayTitle(hour: number): string {
  return `${briefTimeOfDayLabel(hour)}简报`;
}

export function localHourInZone(date: Date, timeZone: string): number {
  const value = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .find((part) => part.type === "hour")?.value ?? "0";
  return Number(value);
}

export function tzOffsetMs(date: Date, timeZone: string): number {
  const iso = formatIso(date, timeZone);
  const match = iso.match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60 * 1000;
}

/**
 * 把「YYYY-MM-DDTHH:mm」或已带偏移的 ISO 写成带时区偏移的 ISO。
 * 不带偏移的输入按 timeZone 的民用时间解释，不依赖机器时区。
 */
export function civilToIso(civil: string, timeZone: string): string {
  const trimmed = civil.trim();
  if (!trimmed) throw new Error("缺少时间");
  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) throw new Error(`无法解析时间：${civil}`);
    return formatIso(date, timeZone);
  }
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error(`无法解析时间：${civil}`);
  const stamp = `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`;
  const utcGuess = Date.parse(`${stamp}Z`);
  if (!Number.isFinite(utcGuess)) throw new Error(`无法解析时间：${civil}`);
  let instant = new Date(utcGuess - tzOffsetMs(new Date(utcGuess), timeZone));
  const shown = formatIso(instant, timeZone).slice(0, 19);
  if (shown !== stamp) {
    const delta = Date.parse(`${stamp}Z`) - Date.parse(`${shown}Z`);
    if (Number.isFinite(delta)) instant = new Date(instant.getTime() + delta);
  }
  return formatIso(instant, timeZone);
}

