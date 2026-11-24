/**
 * 从一轮成功的对话里抽出：日记事实、核心档案补丁、待确认的出站草稿。
 * 抽取提示词放在这里，服务层只负责调用与落地。
 */

export type FieldReplacement = { field: string; value: string };

export type ProposedAboutYouPatch = {
  targetPath: string;
  summary: string;
  preview: string;
  replacements: FieldReplacement[];
  baseRevision?: string;
};

export type OutboundDraft = {
  action: string;
  target: string;
  summary: string;
  preview: string;
  /** 聊天通道出站草稿：飞书 / Lark / 钉钉 / 微信。 */
  channelId?: string;
  connectorId?: string;
};

/** 用户明确要求写一篇日常笔记时，助手给出的那一页。 */
export type ProposedNote = {
  title: string;
  body: string;
};

export type MemoryUpdateResult = {
  diaryFacts: Array<{ fact: string; sourceLabel?: string }>;
  patches: ProposedAboutYouPatch[];
  outboundDraft?: OutboundDraft;
  /** 用户要「写一页笔记」时落地的那一页，不是核心档案。 */
  note?: ProposedNote;
  usedModel: boolean;
  inputTokens?: number;
  outputTokens?: number;
};

export interface MemoryUpdateProvider {
  type: string;
  complete(
    messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

export const CORE_PATCH_TARGETS = [
  "about-you/profile.md",
  "about-you/work.md",
  "about-you/lifestyle.md",
] as const;

const GREETINGS = /^(你好|您好|嗨|哈喽|hi|hello|hey|yo|在吗|早|早上好|晚上好|下午好|谢谢|多谢)[！!。.，,、~\s]*$/i;

const OUTBOUND_ACTION = "message.draft.send";
const CHANNEL_OUTBOUND_ACTION = "channel.message.send";

/** 聊天通道的名字别名。飞书 / Lark / 钉钉 / 微信都是一等通道。 */
const CHANNEL_TARGETS = [
  { id: "feishu", name: "飞书", pattern: /飞书|feishu/i },
  { id: "lark", name: "Lark", pattern: /\blark\b/i },
  { id: "dingtalk", name: "钉钉", pattern: /钉钉|dingtalk/i },
  { id: "weixin", name: "微信", pattern: /微信|weixin|wechat/i },
] as const;

function matchChannelTarget(text: string): { id: string; name: string } | undefined {
  for (const item of CHANNEL_TARGETS) {
    if (item.pattern.test(text)) return { id: item.id, name: item.name };
  }
  return undefined;
}

const EXTRACTION_PROMPT = `你是一个记忆整理器。只输出 JSON，不要解释。
JSON 结构：
{
  "diaryFacts": ["一句话事实"],
  "patches": [{ "targetPath": "about-you/profile.md", "summary": "一句话", "replacements": [{ "field": "称呼", "value": "方陈" }] }],
  "outboundDraft": { "target": "同事", "summary": "拟发送一条消息给同事", "preview": "消息正文" },
  "note": { "title": "笔记标题", "body": "笔记正文" }
}
规则：
- 只记用户这轮话里明确说过的事实，不要推测。
- targetPath 只能是 about-you/profile.md、about-you/work.md、about-you/lifestyle.md、about-you/identity.md、about-you/devices.md。
- patches 只在用户确实说了对应信息时才给；档案里已有的相同值不要再提。
- outboundDraft 只在用户要「拟一条消息」时给，不要说已经发出。
- note 只在用户明确要「写一页笔记」时给，其他时候不要给。`;

export async function extractMemoryUpdate(input: {
  userText: string;
  assistantText: string;
  aboutYou: Array<{ relativePath: string; title: string; content: string }>;
  provider?: MemoryUpdateProvider;
}): Promise<MemoryUpdateResult> {
  const local = withAssistantBody(localExtraction(input.userText, input.aboutYou), input.assistantText);
  if (!input.provider || input.provider.type === "mock") {
    return { ...local, usedModel: false };
  }

  let raw: string;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const completion = await input.provider.complete([
      { role: "system", content: EXTRACTION_PROMPT },
      {
        role: "user",
        content: `用户这轮说的话：\n${input.userText}\n\n助手回复：\n${input.assistantText}`,
      },
    ]);
    raw = completion.text;
    inputTokens = completion.inputTokens;
    outputTokens = completion.outputTokens;
  } catch {
    return { ...local, usedModel: false };
  }

  const parsed = parseModelJson(raw);
  if (!parsed) {
    return { ...local, usedModel: true, inputTokens, outputTokens };
  }
  return {
    diaryFacts: normalizeDiaryFacts(parsed.diaryFacts, local.diaryFacts),
    patches: normalizePatches(parsed.patches, input.aboutYou, local.patches),
    outboundDraft: normalizeDraft(parsed.outboundDraft, local.outboundDraft),
    note: normalizeNote(parsed.note, local.note),
    usedModel: true,
    inputTokens,
    outputTokens,
  };
}

/** 按行替换 `- 字段：值`，没有该行时追加到正文列表末尾。frontmatter 保留。 */
export function applyFieldReplacements(content: string, replacements: FieldReplacement[]): string {
  if (!replacements.length) return content;
  const { front, body } = splitFrontmatter(content);
  const lines = body.split("\n");
  for (const replacement of replacements) {
    const field = replacement.field.trim();
    if (!field) continue;
    const value = replacement.value.trim();
    let index = -1;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(\s*[-*]\s*)([^：:]*?)([：:])(\s*)(.*)$/);
      if (!match) continue;
      if (match[2].trim() !== field) continue;
      index = i;
      break;
    }
    if (index >= 0) {
      lines[index] = `- ${field}：${value}`;
      continue;
    }
    const at = lastListIndex(lines);
    if (at >= 0) lines.splice(at + 1, 0, `- ${field}：${value}`);
    else lines.push(`- ${field}：${value}`);
  }
  return `${front}${lines.join("\n")}`;
}

function lastListIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[-*]\s+\S/.test(lines[i])) return i;
  }
  return -1;
}

function splitFrontmatter(content: string): { front: string; body: string } {
  if (!content.startsWith("---")) return { front: "", body: content };
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return { front: `${lines.slice(0, i + 1).join("\n")}\n`, body: lines.slice(i + 1).join("\n") };
    }
  }
  return { front: "", body: content };
}

function localExtraction(
  userText: string,
  aboutYou: Array<{ relativePath: string; title: string; content: string }>,
): MemoryUpdateResult {
  const text = (userText ?? "").trim();
  if (!text || GREETINGS.test(text)) {
    return { diaryFacts: [], patches: [], usedModel: false };
  }

  const outboundDraft = matchOutboundDraft(text);
  const note = matchNoteIntent(text);

  const profile = readProfile(aboutYou, "about-you/profile.md");
  const work = readProfile(aboutYou, "about-you/work.md");
  const lifestyle = readProfile(aboutYou, "about-you/lifestyle.md");

  const name = matchName(text);
  const city = matchCity(text);
  const job = matchWork(text);
  const trip = matchTrip(text);
  const eveningRaw = matchEvening(text);
  const evening = eveningRaw ? canonicalizePreference(eveningRaw) : undefined;

  const parts: string[] = [];
  if (name) parts.push(`我叫${name}`);
  if (city) parts.push(`在${city}`);
  if (job) parts.push(`做${job}`);
  if (trip) parts.push(trip);
  if (evening && !samePreference(evening, lifestyle["作息"] ?? "")) parts.push(evening);

  const diaryFacts: Array<{ fact: string; sourceLabel?: string }> = [];
  if (parts.length) {
    diaryFacts.push({ fact: `${parts.join("，")}。`, sourceLabel: "来自聊天" });
  } else if (!outboundDraft && !note && !isActionRequest(text)) {
    diaryFacts.push({ fact: truncate(stripRememberPrefix(text), 120), sourceLabel: "来自聊天" });
  }

  const patches: ProposedAboutYouPatch[] = [];
  const profileReplacements: FieldReplacement[] = [];
  if (name && profile["称呼"] !== name) profileReplacements.push({ field: "称呼", value: name });
  if (city && profile["所在城市"] !== city) profileReplacements.push({ field: "所在城市", value: city });
  if (profileReplacements.length) {
    patches.push(makePatch("about-you/profile.md", "更新基本档案", profileReplacements));
  }
  if (job && work["正在做的事"] !== job) {
    patches.push(makePatch("about-you/work.md", "更新工作档案", [{ field: "正在做的事", value: job }]));
  }
  if (evening && !samePreference(evening, lifestyle["作息"] ?? "")) {
    patches.push(makePatch("about-you/lifestyle.md", "更新生活习惯", [{ field: "作息", value: evening }]));
  }

  return { diaryFacts, patches, outboundDraft, note, usedModel: false };
}

function makePatch(
  targetPath: string,
  label: string,
  replacements: FieldReplacement[],
): ProposedAboutYouPatch {
  const lines = replacements.map((r) => `- ${r.field}：${r.value}`);
  return {
    targetPath,
    summary: `${label}：${replacements.map((r) => r.field).join("、")}`,
    preview: lines.join("\n"),
    replacements,
  };
}

function readProfile(
  aboutYou: Array<{ relativePath: string; title: string; content: string }>,
  relativePath: string,
): Record<string, string> {
  const file = aboutYou.find((item) => item.relativePath === relativePath);
  const out: Record<string, string> = {};
  if (!file) return out;
  for (const line of file.content.split("\n")) {
    const match = line.match(/^\s*[-*]\s+([^：:]+)[：:]\s*(.*)$/);
    if (!match) continue;
    out[match[1].trim()] = match[2].trim();
  }
  return out;
}

function matchName(text: string): string | undefined {
  const match = text.match(/我(?:叫|的名字叫|名字是|是)\s*([一-龥A-Za-z][一-龥A-Za-z0-9·]{0,11})/);
  return match?.[1];
}

function matchCity(text: string): string | undefined {
  const match = text.match(/在\s*([一-龥]{2,10}?)\s*(?:做|工作|上班|生活|住|读书|做产品)/);
  return match?.[1];
}

function matchWork(text: string): string | undefined {
  const match = text.match(
    /(?:在[^，。,；;：:\s]{2,10}?\s*)?做\s*([一-龥A-Za-z]{2,10}?)(?:的工作|产品|东西|事情|事|儿|方向|[，。,；;：:\s]|$)/,
  );
  return match?.[1];
}

function matchTrip(text: string): string | undefined {
  const match = text.match(
    /(?:要去|会去|打算去|计划去|去了|去)\s*([一-龥]{2,10}?)\s*(出差|旅行|旅游|游玩)(?:\s*([一二三四五六七八九十两\d]+)\s*天)?/,
  );
  if (!match) return undefined;
  const city = match[1] ?? "";
  const kind = match[2] ?? "出差";
  const days = match[3] ?? "";
  if (!city) return undefined;
  const whenMatch = text.match(/(今[天日]|明天|后天|这[个]?周[末]?|下[个]?周[末]?|这星期|下星期|这礼拜|下礼拜)/);
  const head = whenMatch?.[1] ? `${whenMatch[1]}要去` : "要去";
  return `${head}${city}${kind}${days ? `${days}天` : ""}`;
}

function matchEvening(text: string): string | undefined {
  const match = text.match(
    /(晚上|夜里|夜间)[^，。,；;！!？?\s]{0,10}?(?:不喜欢|不希望|不想|不爱|受不了|避免)(?:被)?(?:打扰|打断|吵|烦|打扰到)/,
  );
  return match?.[0];
}

const PREFERENCE_FILLERS = /还是|其实|的确|确实|挺|比较/g;

function canonicalizePreference(value: string): string {
  return value.replace(PREFERENCE_FILLERS, "").replace(/\s+/g, "").replace(/[。！？.]+$/u, "").trim();
}

function samePreference(next: string, existing: string): boolean {
  const a = canonicalizePreference(next);
  const b = canonicalizePreference(existing);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function stripRememberPrefix(text: string): string {
  return text.replace(/^(?:请)?(?:帮我)?(?:记一下|记住|记下)[：:，,\s]*/, "").trim() || text;
}

function isActionRequest(text: string): boolean {
  return (
    /(?:拟|起草|写|草拟|准备).{0,8}?(一条|个)?.{0,6}?消息/.test(text) ||
    /(?:列出|列一下|列一列)/.test(text) ||
    /先别发|先不要发|别发出去|不要发出去/.test(text)
  );
}

/** 「写一页关于 X 的笔记」「把刚才的内容记成笔记」这类说法。 */
const NOTE_PATTERNS = [
  /(?:写|记|存|整理|新建|创建|开)(?:一|1)?\s*(?:页|篇|个|张|条)\s*(?:关于\s*([^\s，,。！？：:]{1,20}?)\s*的)?笔记/,
  /(?:写|记|存|整理|新建|创建|开)(?:成|为|到)\s*(?:一|1)?\s*(?:页|篇|个|张|条)?\s*笔记/,
];

/**
 * 认出「写一页笔记」的意图。
 * 只认动词加量词或「写成/记成」的说法，免得把「我有记笔记的习惯」也当成要写笔记。
 */
export function matchNoteIntent(text: string): ProposedNote | undefined {
  const source = (text ?? "").trim();
  if (!source) return undefined;
  for (const pattern of NOTE_PATTERNS) {
    const match = pattern.exec(source);
    if (!match) continue;
    const rest = source
      .slice(match.index + match[0].length)
      .replace(/^[\s：:，,。.、；;]+/, "")
      .trim();
    return { title: (match[1] ?? "").trim(), body: rest };
  }
  return undefined;
}

/** 用户没给正文时，用助手刚才那段话作为这一页的初稿。 */
function withAssistantBody(result: MemoryUpdateResult, assistantText: string): MemoryUpdateResult {
  if (!result.note) return result;
  const body = result.note.body.trim() || (assistantText ?? "").trim().slice(0, 4000);
  return {
    ...result,
    note: {
      title: noteTitle(result.note.title, body),
      body,
    },
  };
}

function noteTitle(title: string, body: string): string {
  const trimmed = title.trim();
  if (trimmed) return trimmed;
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "";
  return truncate(firstLine.replace(/^#+\s*/, ""), 24);
}

/** 只有用户明确要笔记时，才接受模型给出的那一页。 */
function normalizeNote(value: unknown, fallback: ProposedNote | undefined): ProposedNote | undefined {
  if (!fallback) return undefined;
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";
  if (!title && !body) return fallback;
  return {
    title: title || fallback.title,
    body: body || fallback.body,
  };
}

function matchOutboundDraft(text: string): OutboundDraft | undefined {
  const wantsDraft = /(?:拟|起草|写|草拟|准备).{0,8}?(一条|个)?.{0,6}?消息/.test(text);
  const holdBack = /(?:先别发|先不要发|别发出去|不要发出去|先不发|暂时不发|先别真的发)/.test(text);
  if (!wantsDraft || !holdBack) return undefined;
  const channel = matchChannelTarget(text);
  if (channel) {
    const body = extractDraftBody(text);
    return {
      action: CHANNEL_OUTBOUND_ACTION,
      target: channel.name,
      summary: `拟发送一条消息到${channel.name}`,
      preview: body,
      channelId: channel.id,
      connectorId: channel.id,
    };
  }
  const targetMatch = text.match(/(?:发给|给|写给)\s*([一-龥A-Za-z]{1,10}?)(?:的|一条|一个|说|讲|道|，|,|。|；|;|$)/);
  const target = targetMatch?.[1] ?? "对方";
  const body = extractDraftBody(text);
  return {
    action: OUTBOUND_ACTION,
    target,
    summary: `拟发送一条消息给${target}`,
    preview: body,
  };
}

function extractDraftBody(text: string): string {
  const match = text.match(
    /(?:就说|就讲|就写|就提一句|就提|说明一下|说一下|告诉(?:同事|他|她|他们)|内容是)[：:，,]?\s*(.+)$/s,
  );
  if (match?.[1]) {
    const body = match[1].trim().replace(/^[「『""]|[」』""]$/g, "").replace(/[。]+$/, "");
    if (body) return /[。！？]$/.test(body) ? body : `${body}。`;
  }
  return "你好，想跟你说一件事。";
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface ModelJson {
  diaryFacts?: unknown;
  patches?: unknown;
  outboundDraft?: unknown;
  note?: unknown;
}

function parseModelJson(raw: string): ModelJson | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as ModelJson;
  } catch {
    return undefined;
  }
}

function normalizeDiaryFacts(
  value: unknown,
  fallback: Array<{ fact: string; sourceLabel?: string }>,
): Array<{ fact: string; sourceLabel?: string }> {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((fact) => ({ fact, sourceLabel: "来自聊天" }));
  return items.length ? items : fallback;
}

function normalizePatches(
  value: unknown,
  aboutYou: Array<{ relativePath: string; title: string; content: string }>,
  fallback: ProposedAboutYouPatch[],
): ProposedAboutYouPatch[] {
  if (!Array.isArray(value)) return fallback;
  const patches: ProposedAboutYouPatch[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const targetPath = typeof record.targetPath === "string" ? record.targetPath.trim() : "";
    if (!targetPath.startsWith("about-you/")) continue;
    const replacements = normalizeReplacements(record.replacements);
    if (!replacements.length) continue;
    const existing = readProfile(aboutYou, targetPath);
    const meaningful = replacements.filter((r) => existing[r.field] !== r.value && !samePreference(r.value, existing[r.field] ?? ""));
    if (!meaningful.length) continue;
    patches.push(makePatch(targetPath, typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : "更新档案", meaningful));
  }
  return patches.length ? patches : fallback;
}

function normalizeReplacements(value: unknown): FieldReplacement[] {
  if (!Array.isArray(value)) return [];
  const out: FieldReplacement[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const field = typeof record.field === "string" ? record.field.trim() : "";
    const fieldValue = typeof record.value === "string" ? record.value.trim() : "";
    if (!field || !fieldValue) continue;
    out.push({ field, value: fieldValue });
  }
  return out;
}

function normalizeDraft(value: unknown, fallback: OutboundDraft | undefined): OutboundDraft | undefined {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const preview = typeof record.preview === "string" ? record.preview.trim() : "";
  if (!preview) return fallback;
  const target = typeof record.target === "string" && record.target.trim() ? record.target.trim() : "对方";
  const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : `拟发送一条消息给${target}`;
  const channel = matchChannelTarget(`${target} ${summary}`);
  if (channel) {
    return {
      action: CHANNEL_OUTBOUND_ACTION,
      target: channel.name,
      summary: `拟发送一条消息到${channel.name}`,
      preview,
      channelId: channel.id,
      connectorId: channel.id,
    };
  }
  return {
    action: OUTBOUND_ACTION,
    target,
    summary,
    preview,
  };
}
