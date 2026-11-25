import { describe, expect, it } from "vitest";
import {
  UNCONFIGURED_TRANSCRIBE_ERROR,
  isSpeechCapable,
  resolveSpeechProvider,
  speechEndpoint,
  transcribeAudio,
} from "./transcribe";

const successFetch: typeof fetch = async (url, init) => {
  expect(String(url)).toBe("https://api.minimax.cn/v1/speech_to_text");
  expect(init?.method).toBe("POST");
  const headers = (init && init.headers) as Record<string, string> | undefined;
  expect(headers && headers.authorization).toBe("Bearer sk-test-not-real");
  return new Response(JSON.stringify({ text: "  后天下午我要提前走。  " }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const failFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ error: { message: "bad" } }), { status: 401 });


describe("@huoye/core transcribe", () => {
  it("treats mock and keyless providers as unconfigured", async () => {
    expect(isSpeechCapable({ type: "mock", name: "Mock", modelId: "mock-ye" })).toBe(false);
    const resolved = resolveSpeechProvider(
      [
        { id: "mock", type: "mock", name: "Mock（演示）", modelId: "mock-ye", hasApiKey: false },
        {
          id: "mmx",
          type: "openai_compatible",
          name: "MiniMax",
          baseUrl: "https://api.minimax.cn/v1",
          modelId: "MiniMax-M2",
          hasApiKey: false,
        },
      ],
      {},
    );
    expect(resolved).toBeNull();
    const result = await transcribeAudio(null, {
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "a.wav",
    });
    expect(result).toEqual({ ok: false, unconfigured: true, error: UNCONFIGURED_TRANSCRIBE_ERROR });
    expect(result.ok).toBe(false);
  });

  it("resolves a MiniMax provider that already has a workspace key", () => {
    const resolved = resolveSpeechProvider(
      [
        { id: "mock", type: "mock", name: "Mock（演示）", modelId: "mock-ye", hasApiKey: false },
        {
          id: "mmx",
          type: "openai_compatible",
          name: "MiniMax",
          baseUrl: "https://api.minimax.cn/v1",
          modelId: "MiniMax-M2",
          hasApiKey: true,
        },
      ],
      { mmx: "sk-test-not-real" },
    );
    expect(resolved?.id).toBe("mmx");
    expect(resolved?.endpoint).toBe("https://api.minimax.cn/v1/speech_to_text");
    expect(resolved?.modelId).toBe("asr-1.0");
    expect(speechEndpoint("https://api.minimax.io/v1/")).toBe("https://api.minimax.io/v1/speech_to_text");
  });

  it("transcribes through the injected fetch and does not invent an empty transcript", async () => {
    const provider = resolveSpeechProvider(
      [
        {
          id: "mmx",
          type: "openai_compatible",
          name: "MiniMax",
          baseUrl: "https://api.minimax.cn/v1",
          modelId: "asr-1.0",
          hasApiKey: true,
        },
      ],
      { mmx: "sk-test-not-real" },
    );
    const result = await transcribeAudio(provider, {
      bytes: new Uint8Array([1, 2, 3]),
      fileName: "note.wav",
      fetchImpl: successFetch,
    });
    expect(result).toEqual({
      ok: true,
      text: "后天下午我要提前走。",
      providerId: "mmx",
      modelId: "asr-1.0",
    });
  });

  it("returns an honest failure when the speech API errors", async () => {
    const provider = resolveSpeechProvider(
      [
        {
          id: "mmx",
          type: "openai_compatible",
          name: "MiniMax",
          baseUrl: "https://api.minimax.cn/v1",
          modelId: "asr-1.0",
          hasApiKey: true,
        },
      ],
      { mmx: "sk-test-not-real" },
    );
    const result = await transcribeAudio(provider, {
      bytes: new Uint8Array([1]),
      fileName: "note.wav",
      fetchImpl: failFetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unconfigured).toBeUndefined();
      expect(result.error).toContain("转写没有成功");
    }
  });
});
