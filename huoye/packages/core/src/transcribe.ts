import type { ModelProviderConfig } from "@huoye/schema";

export const UNCONFIGURED_TRANSCRIBE_ERROR = "还没有配置可用的语音转写";

const MINIMAX_HINT = /minimax/i;
const SPEECH_MODEL = /^(asr-1|speech[-_])/i;

export interface SpeechProvider {
  id: string;
  name: string;
  modelId: string;
  endpoint: string;
  apiKey: string;
}

export interface TranscribeInput {
  bytes: Uint8Array | Buffer;
  fileName: string;
  mimeType?: string;
  language?: string;
  fetchImpl?: typeof fetch;
}

export interface TranscribeSuccess {
  ok: true;
  text: string;
  providerId: string;
  modelId: string;
}

export interface TranscribeFailure {
  ok: false;
  error: string;
  unconfigured?: boolean;
}

export type TranscribeResult = TranscribeSuccess | TranscribeFailure;

/** 只有工作区里已保存密钥、并且供应商像是 MiniMax / 语音转写时才算可用。不读取进程环境变量里的密钥。 */
export function resolveSpeechProvider(
  providers: ModelProviderConfig[],
  keys: Record<string, string | undefined>,
): SpeechProvider | null {
  for (const provider of providers) {
    if (provider.type === "mock") continue;
    const apiKey = (keys[provider.id] ?? "").trim();
    if (!apiKey) continue;
    if (!isSpeechCapable(provider)) continue;
    const endpoint = speechEndpoint(provider.baseUrl);
    if (!endpoint) continue;
    return {
      id: provider.id,
      name: provider.name,
      modelId: speechModelId(provider.modelId),
      endpoint,
      apiKey,
    };
  }
  return null;
}

export function isSpeechCapable(provider: Pick<ModelProviderConfig, "name" | "baseUrl" | "modelId" | "type">): boolean {
  if (provider.type === "mock") return false;
  return (
    MINIMAX_HINT.test(provider.baseUrl ?? "") ||
    MINIMAX_HINT.test(provider.name ?? "") ||
    SPEECH_MODEL.test(provider.modelId ?? "")
  );
}

export function speechEndpoint(baseUrl?: string): string | null {
  const raw = (baseUrl ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.pathname.endsWith("/speech_to_text")) return url.toString().replace(/\/$/, "");
    const trimmed = url.pathname.replace(/\/+$/, "");
    url.pathname = `${trimmed}/speech_to_text`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function speechModelId(modelId?: string): string {
  if (modelId && SPEECH_MODEL.test(modelId)) return modelId;
  return "asr-1.0";
}

export async function transcribeAudio(
  provider: SpeechProvider | null,
  input: TranscribeInput,
): Promise<TranscribeResult> {
  if (!provider) {
    return { ok: false, unconfigured: true, error: UNCONFIGURED_TRANSCRIBE_ERROR };
  }
  const doFetch = input.fetchImpl ?? fetch;
  const fileName = input.fileName || "audio.wav";
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  const blob = new Blob([bytes], { type: input.mimeType || guessMime(fileName) });
  const form = new FormData();
  form.set("model", provider.modelId);
  form.set("file", blob, fileName);
  form.set("response_format", "json");
  const headers: Record<string, string> = {
    authorization: `Bearer ${provider.apiKey}`,
  };
  if (input.language) headers.language = input.language;
  try {
    const response = await doFetch(provider.endpoint, { method: "POST", headers, body: form });
    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, error: `转写没有成功（${response.status}）` };
    }
    let parsed: { text?: unknown };
    try {
      parsed = JSON.parse(raw) as { text?: unknown };
    } catch {
      return { ok: false, error: "转写没有成功：返回的不是文本结果" };
    }
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) return { ok: false, error: "转写没有成功：没有识别出文本" };
    return { ok: true, text, providerId: provider.id, modelId: provider.modelId };
  } catch {
    return { ok: false, error: "转写没有成功，请稍后再试" };
  }
}

function guessMime(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "wav") return "audio/wav";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "aac") return "audio/aac";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "opus") return "audio/opus";
  if (ext === "flac") return "audio/flac";
  if (ext === "webm") return "audio/webm";
  return "application/octet-stream";
}
