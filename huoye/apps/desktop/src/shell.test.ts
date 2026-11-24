import { describe, expect, it } from "vitest";
import { isAllowedAppUrl, probeLocalServer, resolveAppOrigin, serverMissingHtml } from "./shell";

describe("@huoye/desktop shell", () => {
  it("resolves the window origin to loopback, even if HUOYE_HOST is 0.0.0.0", () => {
    expect(resolveAppOrigin({})).toBe("http://127.0.0.1:5173");
    expect(resolveAppOrigin({ HUOYE_HOST: "0.0.0.0", HUOYE_WEB_PORT: "5174" })).toBe("http://127.0.0.1:5174");
    expect(resolveAppOrigin({ HUOYE_HOST: "example.com", HUOYE_WEB_PORT: "5173" })).toBe("http://127.0.0.1:5173");
  });

  it("only allows the local app origin and rejects remote sites", () => {
    const origin = "http://127.0.0.1:5173";
    expect(isAllowedAppUrl("http://127.0.0.1:5173/", origin)).toBe(true);
    expect(isAllowedAppUrl("http://127.0.0.1:5173/today", origin)).toBe(true);
    expect(isAllowedAppUrl("http://localhost:5173/settings", origin)).toBe(true);
    expect(isAllowedAppUrl("http://127.0.0.1:5174/", origin)).toBe(false);
    expect(isAllowedAppUrl("http://127.0.0.1:8787/api/health", origin)).toBe(false);
    expect(isAllowedAppUrl("https://today.ai/", origin)).toBe(false);
    expect(isAllowedAppUrl("http://today.ai/", origin)).toBe(false);
    expect(isAllowedAppUrl("https://example.com/", origin)).toBe(false);
    expect(isAllowedAppUrl("file:///etc/passwd", origin)).toBe(false);
  });

  it("explains in Chinese that pnpm dev must be running when the probe fails", async () => {
    const origin = "http://127.0.0.1:5173";
    const html = serverMissingHtml(origin);
    expect(html).toContain("还没有连上本机的活页服务");
    expect(html).toContain("pnpm dev");
    expect(html).toContain("http://127.0.0.1:5173");
    expect(html).not.toContain("today.ai");
    expect(html).not.toContain("<script");

    const down = await probeLocalServer(origin, async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(down).toBe(false);

    const up = await probeLocalServer(origin, async () => new Response("ok", { status: 200 }));
    expect(up).toBe(true);
  });
});
