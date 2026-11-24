import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

function freshApp() {
  const home = mkdtempSync(path.join(os.tmpdir(), "huoye-first-run-"));
  const created = createApp({ home, now: () => new Date("2026-11-23T15:10:00+08:00") });
  return { app: created.app, workspace: created.workspace, home };
}

async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const raw = await res.text();
  const events: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    events.push(JSON.parse(payload) as Record<string, unknown>);
  }
  return events;
}

describe("@huoye/server first-run without a model key", () => {
  it("opens a brand-new workspace, keeps skip-from-empty names, and works in local/no-key mode", async () => {
    const { app, workspace, home } = freshApp();

    expect(existsSync(path.join(home, "secrets.json"))).toBe(false);
    const settings = workspace.readSettings();
    expect(settings.defaultProviderId).toBe("mock");
    expect(settings.assistantName).toBe("叶");
    expect(settings.providers.some((p) => p.type === "openai_compatible" && p.hasApiKey)).toBe(false);

    const skip = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "你", assistantName: "叶", onboardingCompleted: true }),
    });
    expect(skip.status).toBe(200);

    const pending = await app.request("/api/confirmations");
    const pendingBody = (await pending.json()) as { items: Array<{ status: string; action: string }> };
    expect(pendingBody.items.filter((item) => item.status === "pending")).toEqual([]);
    expect(pendingBody.items.some((item) => item.action === "demo.message.send")).toBe(false);

    // Completing again with a blank name must not be done by the client helper;
    // if a later write only sets onboardingCompleted, the existing name stays.
    const again = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ onboardingCompleted: true }),
    });
    expect(again.status).toBe(200);
    const after = (await again.json()) as { displayName: string; assistantName: string };
    expect(after.displayName).toBe("你");
    expect(after.assistantName).toBe("叶");

    const briefRes = await app.request("/api/today/brief", { method: "POST" });
    expect(briefRes.status).toBe(200);
    const brief = (await briefRes.json()) as { source: string; fallbackMessage?: string; text: string };
    expect(brief.source).toBe("local");
    expect(brief.fallbackMessage).toBeUndefined();
    expect(brief.text).toContain("下午好");

    const health = await app.request("/api/health-notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sleep: "大约睡了 6 小时", mood: "还好" }),
    });
    expect(health.status).toBe(201);

    const created = await app.request("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "新对话" }),
    });
    const chat = (await created.json()) as { id: string };
    const stream = await app.request(`/api/chats/${chat.id}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "你好" }),
    });
    expect(stream.status).toBe(200);
    const events = await readSse(stream);
    const done = events.find((event) => event.type === "done");
    const failed = events.find((event) => event.type === "error");
    expect(failed).toBeUndefined();
    expect(String(done?.text ?? "")).toContain("叶");

    const usage = (await (await app.request("/api/usage/events")).json()) as {
      items: Array<{ purpose: string }>;
    };
    expect(usage.items.some((item) => item.purpose === "brief")).toBe(false);
    expect(existsSync(path.join(home, "secrets.json"))).toBe(false);
  });
});
