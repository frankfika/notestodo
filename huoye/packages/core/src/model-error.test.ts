import { describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider } from "./providers";
import {
  modelErrorMessage,
  modelFallbackMessage,
  modelHttpError,
} from "./model-error";

const LIMIT_BODY =
  '{"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)","http_code":"429"},"request_id":"07530e3f8bbede563b49006aa4af632d"}';

const limitedFetch: typeof fetch = async () =>
  new Response(LIMIT_BODY, { status: 429, headers: { "content-type": "application/json" } });

describe("@huoye/core model-error", () => {
  it("turns a MiniMax quota payload into the same Chinese reason for chat and brief, without JSON", () => {
    const error = modelHttpError(429, LIMIT_BODY);
    const chat = modelErrorMessage(error);
    const brief = modelFallbackMessage(error);
    expect(chat).toBe(
      "模型这次没有写出来（已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)）。",
    );
    expect(brief).toBe(
      "模型这次没有写出来（已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)），已改用本地档案整理一版。",
    );
    for (const text of [chat, brief, error.message]) {
      expect(text).not.toMatch(/\{/);
      expect(text).not.toContain("request_id");
      expect(text).not.toContain("rate_limit_error");
      expect(text).not.toContain("http_code");
    }
  });

  it("is idempotent and strips leftover stacks or key-like tokens", () => {
    const clean =
      "模型这次没有写出来（已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)）。";
    expect(modelErrorMessage(new Error(clean))).toBe(clean);
    const stacked = new Error(
      `模型接口请求失败（429）：${LIMIT_BODY}\n    at OpenAiCompatibleProvider.request (providers.ts:149:13)`,
    );
    const chat = modelErrorMessage(stacked);
    expect(chat).toContain("已达到 Token Plan 用量上限");
    expect(chat).not.toMatch(/\{/);
    expect(chat).not.toContain("providers.ts");
    expect(modelErrorMessage(new Error("sk-forbidden-token-should-not-appear"))).toBe(
      "模型这次没有写出来。",
    );
  });

  it("makes OpenAiCompatibleProvider throw the cleaned chat wording", async () => {
    const provider = new OpenAiCompatibleProvider(
      "prv_fixture",
      "MiniMax-M3.1-Flash",
      "https://api.minimax.cn/v1",
      "fixture-workspace-key",
      limitedFetch,
    );
    await expect(provider.complete([{ role: "user", content: "你好" }])).rejects.toThrow(
      "模型这次没有写出来（已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)）。",
    );
    await expect(provider.complete([{ role: "user", content: "你好" }])).rejects.not.toThrow(/\{/);
  });
});
