import type { ModelProviderConfig } from "@huoye/schema";
import { modelHttpError } from "./model-error";

export interface ChatTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface CompletionChunk {
  text: string;
  done?: boolean;
}

export interface CompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelProvider {
  id: string;
  type: ModelProviderConfig["type"];
  modelId: string;
  complete(messages: ChatTurn[], options?: { assistantName?: string }): Promise<CompletionResult>;
  stream(messages: ChatTurn[], options?: { assistantName?: string }): AsyncGenerator<CompletionChunk>;
}

export function estimateTokens(text: string): number {
  // 中英混合的近似计数，足够给 mock 与无官方用量时记一笔。
  const chinese = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = text.replace(/[\u4e00-\u9fff]/g, "");
  return chinese + Math.ceil(rest.length / 4);
}

export class MockProvider implements ModelProvider {
  readonly type = "mock" as const;

  constructor(
    readonly id: string,
    readonly modelId = "mock-ye",
  ) {}

  async complete(messages: ChatTurn[], options?: { assistantName?: string }): Promise<CompletionResult> {
    const text = mockReply(messages, options?.assistantName ?? "叶");
    const inputTokens = estimateTokens(messages.map((m) => m.content).join("\n"));
    const outputTokens = estimateTokens(text);
    return { text, inputTokens, outputTokens };
  }

  async *stream(messages: ChatTurn[], options?: { assistantName?: string }): AsyncGenerator<CompletionChunk> {
    const { text, inputTokens, outputTokens } = await this.complete(messages, options);
    const chunks = splitChunks(text);
    for (const chunk of chunks) {
      yield { text: chunk };
    }
    yield { text: "", done: true };
    void inputTokens;
    void outputTokens;
  }
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly type = "openai_compatible" as const;

  constructor(
    readonly id: string,
    readonly modelId: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(messages: ChatTurn[], _options?: { assistantName?: string }): Promise<CompletionResult> {
    const body = await this.request(messages, false);
    const text = String(body.choices?.[0]?.message?.content ?? "");
    const usage = body.usage ?? {};
    return {
      text,
      inputTokens: Number(usage.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join("\n"))),
      outputTokens: Number(usage.completion_tokens ?? estimateTokens(text)),
    };
  }

  async *stream(messages: ChatTurn[], _options?: { assistantName?: string }): AsyncGenerator<CompletionChunk> {
    const url = new URL("chat/completions", trailingSlash(this.baseUrl));
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        messages,
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => "");
      throw modelHttpError(response.status, errText);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          yield { text: "", done: true };
          return;
        }
        try {
          const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const piece = json.choices?.[0]?.delta?.content;
          if (piece) yield { text: piece };
        } catch {
          // ignore keep-alive
        }
      }
    }
    yield { text: "", done: true };
  }

  private async request(messages: ChatTurn[], stream: boolean): Promise<{
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }> {
    const url = new URL("chat/completions", trailingSlash(this.baseUrl));
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        messages,
        stream,
      }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw modelHttpError(response.status, errText);
    }
    return (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
  }
}

function trailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export function mockReply(messages: ChatTurn[], assistantName: string): string {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content.trim() ?? "";
  if (!last) return `我是${assistantName}。你想从哪件事说起？`;
  if (/^(你好|您好|hi|hello|嗨)[！!。.\s]*$/i.test(last)) {
    return `你好，我是${assistantName}。今天想聊点什么？`;
  }

  const listMatch = last.match(/(?:列出|列一下|列一列|列出来)[^。！？\n]{0,20}?([一二三四五六七八九十两\d]+)件/);
  if (listMatch) {
    const count = parseCount(listMatch[1]) ?? 3;
    const ideas = [
      "把今天最要紧的那件事开个头",
      "把桌上还没归位的草稿收进对应的文件夹",
      "看一眼还没回的消息，能回的先回掉",
      "给明天要出门的东西列一份短清单",
      "抽出十分钟把日历扫一遍，确认有没有冲突",
    ];
    const picked = ideas.slice(0, Math.max(2, Math.min(count, ideas.length)));
    const lines = picked.map((item, index) => `${index + 1}. ${item}`);
    return `可以先做这${listMatch[1]}件小事：\n${lines.join("\n")}`;
  }

  const draftHold = /(?:拟|起草|写|草拟|准备).{0,8}?(一条|个)?.{0,6}?消息/.test(last) && /(?:先别发|先不要发|别发出去|不要发出去|先不发)/.test(last);
  if (draftHold) {
    const bodyMatch = last.match(/(?:就说|就讲|就写|就提一句|就提|说明一下|说一下|内容是)[：:，,]?\s*(.+)$/s);
    const body = bodyMatch?.[1]?.trim().replace(/[。]+$/, "") ?? "";
    if (body) {
      return `好，我先拟一条，不会发出去。\n\n${body}。`;
    }
    return "好，我先拟一条，不会发出去。你还可以补充要说的具体内容。";
  }

  const trip = last.match(/((?:下周|下星期|这周|明天|后天)?[^，。]{0,6}去[一-龥]{2,10}(?:出差|旅行|旅游)(?:[一二三四五六七八九十两\d]+天)?)/);
  if (trip) {
    return `好，我记下了：${trip[1].replace(/^我/, "")}。核心档案如果要改，我会先提出来给你看。`;
  }

  const cleaned = last.replace(/^(?:请)?(?:帮我)?(?:记一下|记住|记下)[：:，,\s]*/, "").trim();
  if (cleaned && cleaned.length <= 40 && cleaned !== last) {
    return `好，我记下了：${cleaned.replace(/[。]+$/, "")}。`;
  }
  return "好，我听到了。需要我记到今天的日记里、整理成任务，还是先帮你起草一版？";
}

function parseCount(raw: string): number | undefined {
  const mapped: Record<string, number> = { 两: 2, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (mapped[raw] != null) return mapped[raw];
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function splitChunks(text: string): string[] {
  const chars = [...text];
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += 2) {
    chunks.push(chars.slice(i, i + 2).join(""));
  }
  return chunks.length ? chunks : [text];
}
