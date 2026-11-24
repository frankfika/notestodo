import { describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider } from "./providers";

describe("@huoye/core OpenAiCompatibleProvider", () => {
  it("sends the constructor key, never a process.env value", async () => {
    const previous = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = "env-key-must-not-be-used";
    const authorizations: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      authorizations.push(headers.get("authorization") ?? "");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "你好。" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    try {
      const provider = new OpenAiCompatibleProvider(
        "prv_fixture",
        "MiniMax-M3.1-Flash",
        "https://api.minimax.cn/v1",
        "fixture-workspace-key",
        fetchImpl,
      );
      const result = await provider.complete([{ role: "user", content: "你好" }]);
      expect(result.text).toBe("你好。");
      expect(result.inputTokens).toBe(3);
      expect(result.outputTokens).toBe(2);
      expect(authorizations).toEqual(["Bearer fixture-workspace-key"]);
    } finally {
      if (previous === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previous;
    }
  });
});
