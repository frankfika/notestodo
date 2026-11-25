import { describe, expect, it } from "vitest";
import { readFailedResponse } from "./api";

describe("readFailedResponse", () => {
  it("reads a non-JSON error body only once and falls back to Chinese", async () => {
    const response = new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain; charset=UTF-8" },
    });
    const result = await readFailedResponse(response, "简报没有整理成功，请稍后再试。");
    expect(result.message).toBe("简报没有整理成功，请稍后再试。");
    expect(result.body).toBe("Internal Server Error");
    await expect(response.text()).rejects.toThrow(/already been read|already read|Body is unusable/i);
  });

  it("uses the JSON error field when present", async () => {
    const response = new Response(JSON.stringify({ error: "简报没有整理成功，请稍后再试。" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    const result = await readFailedResponse(response, "请求没有成功，请稍后再试。");
    expect(result.message).toBe("简报没有整理成功，请稍后再试。");
  });
});
