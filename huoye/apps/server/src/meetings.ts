/**
 * 会议纪要与转写导入。
 *
 * 一条龙：转写（录音、粘贴的文本，或腾讯会议 / 飞书妙记导出的文件）→ 纪要（主题 + 时间 + 要点 + 待办）
 * → 写进 memory/meetings/ → 每条待办带出处进待确认队列，用户确认后才建任务。
 *
 * 模型不可用时诚实失败：原文照样保存，纪要正文里写清楚「还没整理」，不假装整理好了。
 * 模型最多重试一次（MEETING_MAX_ATTEMPTS），不会无限重试。
 */
import { MEETINGS_DIR, uniqueNotePath, writeNote } from "@huoye/memory";
import type { ChatTurn, ModelProvider } from "@huoye/core";
import type { ConfirmationRequest, MemoryFile } from "@huoye/schema";
import { notifyPendingConfirmation } from "./proactive";
import type { Workspace } from "./workspace";

/* ------------------------------------------------------------------ *
 * 转写来源与格式
 * ------------------------------------------------------------------ */

/** 转写来自哪个会议软件。 */
export type TranscriptSource = "tencent_meeting" | "feishu_minutes" | "plain_text";

export const TRANSCRIPT_SOURCE_LABELS: Record<TranscriptSource, string> = {
  tencent_meeting: "腾讯会议",
  feishu_minutes: "飞书妙记",
  plain_text: "普通转写",
};

/** 转写文件的格式。仓库里已有的约定是纯文本；SRT / VTT 是常见的字幕导出，Markdown 是妙记导出的形态。 */
export type TranscriptFormat = "plain_text" | "srt" | "vtt" | "markdown";

export interface TranscriptLine {
  /** 时间点，例如 00:01:12。没有就空着。 */
  time?: string;
  /** 说话人。没有就空着。 */
  speaker?: string;
  /** 说过的话。 */
  text: string;
}

export interface ParsedTranscript {
  source: TranscriptSource;
  format: TranscriptFormat;
  /** 从文件里认出来的会议标题。 */
  title?: string;
  /** 从文件里认出来的会议日期（YYYY-MM-DD）。 */
  date?: string;
  /** 从文件里认出来的会议时间（HH:mm）。 */
  time?: string;
  lines: TranscriptLine[];
  /** 规范化后的纯文本，交给模型、写进正文都用它。 */
  text: string;
  speakers: string[];
  /** 来源是认出来的（true），还是调用方直接说的（false）。 */
  detected: boolean;
}

const TENCENT_NAME = /腾讯会议|tencent[\s_-]*meeting/i;
const FEISHU_NAME = /飞书妙记|妙记|lark[\s_-]*minutes|feishu/i;

/** 认出来源：先看文件名，再看正文开头。认不出就说「普通转写」，不硬套。 */
export function detectTranscriptSource(raw: string, fileName = ""): TranscriptSource {
  const name = fileName.trim();
  if (name && TENCENT_NAME.test(name)) return "tencent_meeting";
  if (name && FEISHU_NAME.test(name)) return "feishu_minutes";
  const head = (raw ?? "").slice(0, 4000);
  if (TENCENT_NAME.test(head)) return "tencent_meeting";
  if (FEISHU_NAME.test(head)) return "feishu_minutes";
  return "plain_text";
}

function detectFormat(raw: string, fileName = ""): TranscriptFormat {
  const name = fileName.toLowerCase();
  const text = (raw ?? "").replace(/^﻿/, "");
  if (name.endsWith(".srt") || /^\s*\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/m.test(text)) {
    return "srt";
  }
  if (name.endsWith(".vtt") || /^\s*WEBVTT/m.test(text)) return "vtt";
  if (/^\s*#{1,6}\s+\S/m.test(text) || /^\s*[-*]\s+\S+/m.test(text)) return "markdown";
  return "plain_text";
}

const TIMECODE = /^\[?(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?$/;
const LEADING_TIME = /^\[?(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]?\s+(.*)$/;
const SPEAKER_LINE = /^([^：:]{1,16})[：:]\s*(.*)$/;
/** 明显不是人名的冒号左边，避免把「好的：我觉得」当成说话人。 */
const NOT_A_SPEAKER = /[。！？，、,.!?;；""'']|^(好的|好吧|然后|所以|但是|另外|总结|结论|备注|待办|议题|说明|提示)$/;

/** 把 1:12 / 00:01:12,500 统一成 00:01:12。 */
export function normalizeTimecode(raw: string): string {
  const text = (raw ?? "").trim().replace(",", ".");
  const parts = text.split(":");
  const numbers = parts.map((part) => Number(part.split(".")[0] ?? ""));
  if (numbers.some((value) => !Number.isFinite(value))) return text;
  const seconds = numbers[numbers.length - 1] ?? 0;
  const minutes = numbers.length >= 2 ? (numbers[numbers.length - 2] ?? 0) : 0;
  const hours = numbers.length >= 3 ? (numbers[numbers.length - 3] ?? 0) : 0;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** 补零成两位。 */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function looksLikeSpeaker(candidate: string): boolean {
  const text = candidate.trim();
  if (!text) return false;
  if (NOT_A_SPEAKER.test(text)) return false;
  if (/\s/.test(text)) return false;
  return true;
}

/**
 * 解析一份转写。
 * 支持仓库原有的纯文本写法（`张三：内容`），也支持常见的 `00:12 张三：内容`、
 * SRT、VTT 和 Markdown 形态。认不出的行原样当正文留着，不丢内容。
 */
export function parseTranscript(
  raw: string,
  options: { source?: TranscriptSource | "auto"; fileName?: string } = {},
): ParsedTranscript {
  const text = (raw ?? "").replace(/\r\n?/g, "\n");
  const requested = options.source && options.source !== "auto" ? options.source : undefined;
  const source = requested ?? detectTranscriptSource(text, options.fileName ?? "");
  const format = detectFormat(text, options.fileName ?? "");
  const meta = extractHeaderMeta(text);
  const lines =
    format === "srt" ? parseCueBlocks(text) : format === "vtt" ? parseCueBlocks(text) : parsePlainLines(text);
  const speakers: string[] = [];
  for (const line of lines) {
    const speaker = line.speaker?.trim();
    if (speaker && !speakers.includes(speaker)) speakers.push(speaker);
  }
  const title = meta.title ?? titleFromFileName(options.fileName ?? "");
  return {
    source,
    format,
    title: title || undefined,
    date: meta.date,
    time: meta.time,
    lines,
    text: normalizeTranscriptText(lines),
    speakers,
    detected: !requested,
  };
}

/** 规范化后的转写：一行一句，能认出发言人和时间点就都带上。 */
export function normalizeTranscriptText(lines: TranscriptLine[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const text = (line.text ?? "").trim();
    if (!text) continue;
    const speaker = line.speaker?.trim();
    const time = line.time?.trim();
    if (speaker && time) out.push(`[${time}] ${speaker}：${text}`);
    else if (speaker) out.push(`${speaker}：${text}`);
    else if (time) out.push(`[${time}] ${text}`);
    else out.push(text);
  }
  return out.join("\n");
}

function parsePlainLines(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  let pendingTime: string | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue; // 标题类行由 header 解析，不当发言。
    if (/^[-*]\s+出处[：:]/.test(line)) continue;
    const timeOnly = line.match(TIMECODE);
    if (timeOnly) {
      pendingTime = normalizeTimecode(timeOnly[1] ?? "");
      continue;
    }
    let time = pendingTime;
    let rest = line;
    pendingTime = undefined;
    const lead = line.match(LEADING_TIME);
    if (lead) {
      time = normalizeTimecode(lead[1] ?? "");
      rest = (lead[2] ?? "").trim();
    }
    const speaker = rest.match(SPEAKER_LINE);
    if (speaker && looksLikeSpeaker(speaker[1] ?? "")) {
      out.push({ time, speaker: (speaker[1] ?? "").trim(), text: (speaker[2] ?? "").trim() });
      continue;
    }
    out.push({ time, text: rest });
  }
  return out;
}

/** SRT 与 VTT 的字幕块结构一样：时间行 + 正文。 */
function parseCueBlocks(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0] ?? "")) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(lines[0] ?? "")) continue;
    const arrowIndex = lines.findIndex((line) => line.includes("-->"));
    if (arrowIndex < 0) continue;
    const start = (lines[arrowIndex] ?? "").split("-->")[0]?.trim() ?? "";
    const body = lines.slice(arrowIndex + 1).join(" ").trim();
    if (!body) continue;
    out.push({ time: normalizeTimecode(start), text: body });
  }
  return out;
}

const TITLE_LABEL = /^(?:会议主题|会议标题|会议名称|主题|标题)\s*[：:]\s*(.+)$/;
const TITLE_HEADING = /^#{1,6}\s*(?:会议主题|会议标题|会议名称|主题|标题)\s*$/;
const TIME_LABEL = /^(?:会议时间|会议日期|时间|日期)\s*[：:]\s*(.+)$/;
const ANY_HEADING = /^#{1,6}\s*(.+)$/;

/** 从正文头部认会议标题与时间。认不出就空着，不编。 */
export function extractHeaderMeta(text: string): { title?: string; date?: string; time?: string } {
  const lines = (text ?? "").split("\n");
  let title: string | undefined;
  let date: string | undefined;
  let time: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line) continue;
    const titleMatch = line.match(TITLE_LABEL);
    if (titleMatch?.[1]) {
      title = titleMatch[1].trim();
      continue;
    }
    if (TITLE_HEADING.test(line)) {
      const next = (lines[index + 1] ?? "").trim();
      if (next && !/^#{1,6}\s/.test(next)) {
        title = next;
        index += 1;
      }
      continue;
    }
    const timeMatch = line.match(TIME_LABEL);
    if (timeMatch?.[1]) {
      const when = parseWhen(timeMatch[1]);
      if (when.date) date = when.date;
      if (when.time) time = when.time;
      continue;
    }
    if (!title) {
      const heading = line.match(ANY_HEADING);
      if (heading?.[1]) {
        const value = heading[1].trim();
        if (value && !/^(会议主题|会议标题|会议名称|主题|标题|转写|记录)$/.test(value)) title = value;
      }
    }
  }
  return { title: title || undefined, date, time };
}

function parseWhen(raw: string): { date?: string; time?: string } {
  const text = (raw ?? "").trim();
  const dateMatch = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
  const out: { date?: string; time?: string } = {};
  if (dateMatch) {
    const [, year, month, day] = dateMatch;
    out.date = `${year}-${String(Number(month)).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
  }
  if (timeMatch) out.time = `${String(Number(timeMatch[1])).padStart(2, "0")}:${timeMatch[2]}`;
  return out;
}

function titleFromFileName(fileName: string): string {
  const base = (fileName ?? "")
    .split(/[/\\]/)
    .pop()!
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .trim();
  if (!base) return "";
  const cleaned = base
    .replace(TENCENT_NAME, " ")
    .replace(FEISHU_NAME, " ")
    .replace(/转写记录|会议记录|文字记录|聊天记录|会议纪要|记录/g, " ")
    .replace(/[-_—\s]+/g, " ")
    .trim();
  return cleaned;
}

/* ------------------------------------------------------------------ *
 * 纪要与待办
 * ------------------------------------------------------------------ */

/** 待办出处：会议名、纪要文件路径、记录时间，加上转写里的说话人或时间点。 */
export interface TodoProvenance {
  meetingTitle: string;
  /** 纪要文件在记忆目录里的相对路径，例如 meetings/产品周会.md。 */
  notePath: string;
  /** 记录时间（带时区偏移的 ISO）。 */
  capturedAt: string;
  /** 转写里的出处：说话人或时间点。 */
  source: string;
  transcriptSource?: TranscriptSource;
}

export interface MeetingTodo {
  /** 要做的事。 */
  text: string;
  /** 出处：说话人或时间点。整理不出出处就不给这条待办。 */
  source: string;
  /** 完整出处：会议名、纪要路径、记录时间。 */
  provenance?: TodoProvenance;
}

export interface MeetingSummary {
  title: string;
  body: string;
  todos: MeetingTodo[];
  /** 这次是不是真的过了模型。 */
  modelUsed: boolean;
  /** 给用户看的一句话：整理好了，还是诚实说明没整理。 */
  message: string;
  /** 原始转写。模型没整理出来时原样保留。 */
  transcript: string;
  /** 模型调用了几次。 */
  attempts: number;
  /** 转写来源。 */
  source?: TranscriptSource;
}

export const MEETING_PROMPT = `你是一个会议纪要整理器。只输出 JSON，不要解释。
JSON 结构：
{ "title": "纪要标题", "body": "纪要正文，Markdown 段落", "todos": [{ "text": "要做的事", "source": "出处：说话人或时间点" }] }
规则：
- 只整理转录里真实说过的内容，不要编造。
- 每条待办都要写得出处；写不出出处就不要给这条待办。
- 正文用 Markdown，段落之间空一行。`;

/** 模型最多调用几次（一次 + 最多重试一次）。硬上限，不允许无限重试。 */
export const MEETING_MAX_ATTEMPTS = 2;
/** 单次模型调用的超时。 */
export const MEETING_MODEL_TIMEOUT_MS = 45_000;

/** 从模型回复里取出纪要 JSON。 */
export function parseMeetingJson(raw: string): { title?: string; body?: string; todos?: MeetingTodo[] } | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const todos: MeetingTodo[] = [];
    if (Array.isArray(record.todos)) {
      for (const item of record.todos) {
        if (!item || typeof item !== "object") continue;
        const todo = item as Record<string, unknown>;
        const text = typeof todo.text === "string" ? todo.text.trim() : "";
        const source = typeof todo.source === "string" ? todo.source.trim() : "";
        if (!text || !source) continue;
        todos.push({ text, source });
      }
    }
    return {
      title: typeof record.title === "string" ? record.title.trim() : undefined,
      body: typeof record.body === "string" ? record.body.trim() : undefined,
      todos,
    };
  } catch {
    return undefined;
  }
}

/** 正文里 `- [ ] xxx（出处：yyy）` 这种写法的待办。 */
export function todosFromBody(body: string): MeetingTodo[] {
  const out: MeetingTodo[] = [];
  for (const line of (body ?? "").split("\n")) {
    const match = line.match(/^\s*[-*]\s+\[\s?\]\s+(.+)$/);
    if (!match) continue;
    const text = match[1] ?? "";
    const source = text.match(/[（(]出处[:：]\s*([^）)]+)[）)]\s*$/)?.[1]?.trim();
    const clean = source ? text.replace(/[（(]出处[:：]\s*[^）)]+[）)]\s*$/, "").trim() : text.trim();
    if (!clean) continue;
    out.push({ text: clean, source: source ?? "" });
  }
  return out;
}

class MeetingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`模型调用超时（${timeoutMs} 毫秒）`);
    this.name = "MeetingTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MeetingTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 调用模型整理转写。最多调用 MEETING_MAX_ATTEMPTS 次（一次 + 最多重试一次），
 * 每次都有超时；失败就抛出去，由调用方给诚实的中文回退。
 */
export async function completeMeetingModel(
  provider: ModelProvider,
  messages: ChatTurn[],
  options: { maxAttempts?: number; timeoutMs?: number } = {},
): Promise<{ text: string; attempts: number }> {
  const requested = options.maxAttempts ?? MEETING_MAX_ATTEMPTS;
  const attempts = Math.max(1, Math.min(requested, MEETING_MAX_ATTEMPTS));
  const timeoutMs = options.timeoutMs ?? MEETING_MODEL_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const completion = await withTimeout(provider.complete(messages), timeoutMs);
      return { text: completion.text ?? "", attempts: attempt };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("模型调用失败");
}

/** 整理一份转录。模型不可用时给出诚实失败的结果，原文仍然保留在正文里。 */
export async function summarizeMeeting(input: {
  provider: ModelProvider | null;
  providerError?: string;
  transcript: string;
  title?: string;
  source?: string;
  transcriptSource?: TranscriptSource;
  maxAttempts?: number;
  timeoutMs?: number;
}): Promise<MeetingSummary> {
  const transcript = (input.transcript ?? "").trim();
  const fallbackTitle = (input.title ?? "").trim() || "会议纪要";
  if (!transcript) {
    return {
      title: fallbackTitle,
      body: "",
      todos: [],
      modelUsed: false,
      message: "没有转录内容，纪要是空的。",
      transcript,
      attempts: 0,
      source: input.transcriptSource,
    };
  }
  if (!input.provider) {
    return {
      title: fallbackTitle,
      body: rawBody(transcript, input.source),
      todos: [],
      modelUsed: false,
      message: `没能整理出纪要：${input.providerError?.trim() || "还没有配置模型密钥"}。原始转写已经保留在纪要里。`,
      transcript,
      attempts: 0,
      source: input.transcriptSource,
    };
  }
  const messages: ChatTurn[] = [
    { role: "system", content: MEETING_PROMPT },
    {
      role: "user",
      content: `转写来源：${input.source?.trim() || "未标注"}\n转录：\n${transcript}`,
    },
  ];
  let raw = "";
  let attempts = 0;
  try {
    const completion = await completeMeetingModel(input.provider, messages, {
      maxAttempts: input.maxAttempts,
      timeoutMs: input.timeoutMs,
    });
    raw = completion.text;
    attempts = completion.attempts;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "未知错误";
    const timeout = error instanceof MeetingTimeoutError;
    return {
      title: fallbackTitle,
      body: rawBody(transcript, input.source),
      todos: [],
      modelUsed: false,
      message: timeout
        ? "没能整理出纪要：模型调用超时。原始转写已经保留在纪要里。"
        : `没能整理出纪要：模型调用失败（${reason}）。原始转写已经保留在纪要里。`,
      transcript,
      attempts,
      source: input.transcriptSource,
    };
  }
  const parsed = parseMeetingJson(raw);
  if (!parsed || !parsed.body) {
    return {
      title: parsed?.title || fallbackTitle,
      body: rawBody(transcript, input.source),
      todos: [],
      modelUsed: true,
      message: "没能整理出纪要：模型没有给出可用的纪要结构。原始转写已经保留在纪要里。",
      transcript,
      attempts,
      source: input.transcriptSource,
    };
  }
  const todos = parsed.todos?.length ? parsed.todos : todosFromBody(parsed.body);
  return {
    title: parsed.title || fallbackTitle,
    body: parsed.body,
    todos,
    modelUsed: true,
    message: todos.length
      ? `纪要整理好了，${todos.length} 条待办已经放进待确认列表，确认后才会建任务。`
      : "纪要整理好了，这次没有整理出待办。",
    transcript,
    attempts,
    source: input.transcriptSource,
  };
}

function rawBody(transcript: string, source?: string): string {
  const head = source ? `> 原文来自：${source}\n> 还没整理成纪要，模型这次没有写出来。\n` : "> 还没整理成纪要，模型这次没有写出来。\n";
  return `${head}\n${transcript}`;
}

/** 给每条待办补上完整出处：会议名、纪要路径、记录时间。 */
export function attachTodoProvenance(
  todos: MeetingTodo[],
  meta: { meetingTitle: string; notePath: string; capturedAt: string; transcriptSource?: TranscriptSource },
): MeetingTodo[] {
  return (todos ?? []).map((todo) => ({
    ...todo,
    provenance: {
      meetingTitle: meta.meetingTitle,
      notePath: meta.notePath,
      capturedAt: meta.capturedAt,
      source: todo.source,
      transcriptSource: meta.transcriptSource,
    },
  }));
}

export interface MeetingNoteMeta {
  title: string;
  /** 会议日期 YYYY-MM-DD。 */
  date?: string;
  /** 会议时间 HH:mm。 */
  time?: string;
  timezone?: string;
  /** 来源标签，例如「腾讯会议」。 */
  source?: string;
  /** 记录时间（带时区偏移的 ISO）。 */
  capturedAt?: string;
  /** 纪要文件在记忆目录里的相对路径。 */
  notePath?: string;
}

/** 纪要正文：主题、时间、要点、待办，末尾留一行机器出处。 */
export function meetingNoteBody(summary: MeetingSummary, meta: MeetingNoteMeta): string {
  const parts: string[] = [];
  parts.push(`## 会议主题\n\n${meta.title.trim() || summary.title.trim() || "会议纪要"}`);
  const when = [meta.date, meta.time].filter(Boolean).join(" ");
  parts.push(
    `## 时间\n\n${when ? `${when}${meta.timezone ? `（${meta.timezone}）` : ""}` : "（这次没有记下时间）"}`,
  );
  parts.push(`## 要点\n\n${summary.body.trim() || "（这次没有整理出要点，原始转写保留在下面。）"}`);
  if (summary.todos.length) {
    const todoLines = summary.todos.map(
      (todo) => `- [ ] ${todo.text}（出处：${todo.source?.trim() || "转写里没写出处"}）`,
    );
    parts.push(`## 待办\n\n${todoLines.join("\n")}`);
  }
  const provenance = [meta.notePath, meta.source, meta.capturedAt].filter(Boolean).join(" · ");
  if (provenance) parts.push(`- 出处：${provenance}`);
  return `${parts.join("\n\n")}\n`;
}

export interface WriteMeetingResult {
  file: MemoryFile;
  path: string;
  title: string;
  /** 写进文件的正文。 */
  body: string;
}

/** 把纪要写进 memory/meetings/。 */
export function writeMeetingNote(
  workspace: Workspace,
  input: {
    summary: MeetingSummary;
    title?: string;
    date?: string;
    time?: string;
    timezone?: string;
    source?: string;
    capturedAt?: string;
  },
): WriteMeetingResult {
  const title = (input.title ?? input.summary.title).trim() || "会议纪要";
  const relative = uniqueNotePath(workspace.memory, title, MEETINGS_DIR);
  const body = meetingNoteBody(input.summary, {
    title,
    date: input.date,
    time: input.time,
    timezone: input.timezone,
    source: input.source,
    capturedAt: input.capturedAt,
    notePath: relative,
  });
  const extra: Record<string, unknown> = {};
  if (input.source) extra.source = input.source;
  if (input.summary.source) extra.transcriptSource = input.summary.source;
  if (input.capturedAt) extra.capturedAt = input.capturedAt;
  const file = writeNote(workspace.memory, {
    path: relative,
    title,
    body,
    expectedRevision: "",
    kind: "meeting",
    date: input.date,
    actor: "agent",
    extra,
  });
  return { file, path: file.relativePath, title, body };
}

/**
 * 会议待办进待确认队列。
 * 这里只创建 pending 记录，不建任务：用户批准后由 app.ts 的 task.create 执行器才真的建任务。
 */
export function requestMeetingTodoConfirmations(
  workspace: Workspace,
  input: {
    todos: MeetingTodo[];
    meetingTitle: string;
    notePath: string;
    capturedAt: string;
    transcriptSource?: TranscriptSource;
    now?: Date;
    timezone?: string;
  },
): ConfirmationRequest[] {
  const out: ConfirmationRequest[] = [];
  for (const todo of input.todos ?? []) {
    const text = (todo.text ?? "").trim();
    if (!text) continue;
    const provenance: TodoProvenance = todo.provenance ?? {
      meetingTitle: input.meetingTitle,
      notePath: input.notePath,
      capturedAt: input.capturedAt,
      source: todo.source,
      transcriptSource: input.transcriptSource,
    };
    const item = workspace.confirmations.requestExternalWrite({
      action: "task.create",
      target: input.meetingTitle,
      summary: `会议待办：${text}`,
      preview: `${text}\n出处：${provenance.source}\n来自：${provenance.meetingTitle} · ${provenance.notePath} · ${provenance.capturedAt}`,
      risk: "low",
      editable: true,
      toolPayload: {
        title: text,
        instruction: text,
        source: provenance.source,
        provenance,
        meeting: input.notePath,
      },
    });
    out.push(item);
    // 在主对话里留一句提醒：等你确认后才执行。
    try {
      notifyPendingConfirmation(
        workspace,
        { id: item.id, summary: item.summary, action: item.action },
        input.now ?? new Date(),
        input.timezone || workspace.readSettings().timezone || "Asia/Shanghai",
      );
    } catch {
      // 提醒写不进去也不影响确认本身。
    }
  }
  return out;
}
