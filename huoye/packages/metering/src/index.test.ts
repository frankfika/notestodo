import { HuoyeDb, MockProvider } from "@huoye/core";
import { describe, expect, it } from "vitest";
import { assertNoSecret, recordUsageEvent, redactSecrets, summarizeUsage } from "./index";

describe("@huoye/metering", () => {
  it("records a mock call as a UsageEvent and summarizes totals", async () => {
    const db = new HuoyeDb(":memory:");
    const provider = new MockProvider("mock");
    const completion = await provider.complete([{ role: "user", content: "你好" }]);
    const event = recordUsageEvent(db, {
      provider: provider.id,
      model: provider.modelId,
      purpose: "conversation",
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      source: "byok",
      unitCostInUsd: 1,
    });
    expect(event.totalTokens).toBe(completion.inputTokens + completion.outputTokens);
    expect(event.estimatedCostUsd).toBeCloseTo(event.totalTokens / 1_000_000, 10);
    const summary = summarizeUsage(db, "Asia/Shanghai");
    expect(summary.today.count).toBe(1);
    expect(summary.today.totalTokens).toBe(event.totalTokens);
    expect(summary.month.totalTokens).toBe(event.totalTokens);
    expect(summary.byPurpose[0]?.purpose).toBe("conversation");
    expect(summary.byModel[0]?.model).toBe("mock-ye");
  });

  it("does not include secrets when serializing logs", () => {
    const apiKey = "sk-live-super-secret-example-key";
    const logged = {
      provider: "openai-compatible",
      apiKey,
      authorization: `Bearer ${apiKey}`,
      nested: { secret: apiKey, model: "demo" },
    };
    const redacted = redactSecrets(logged);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(apiKey);
    expect(redacted.apiKey).toBe("***");
    expect((redacted.nested as { secret: string }).secret).toBe("***");
    expect((redacted.nested as { model: string }).model).toBe("demo");
    expect(() => assertNoSecret(serialized, [apiKey])).not.toThrow();
    expect(() => assertNoSecret(JSON.stringify(logged), [apiKey])).toThrow(/密钥/);
  });
});
