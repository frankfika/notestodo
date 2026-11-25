import { describe, expect, it } from "vitest";
import { memoryHref, memoryPathFromRoute } from "./memory-path";

describe("memory path helper", () => {
  it("does not append a second .md for diary links", () => {
    expect(memoryHref("diaries/2026-11-23.md")).toBe("/memories/diaries/2026-11-23");
    expect(memoryHref("diaries/2026-11-23")).toBe("/memories/diaries/2026-11-23");
    expect(memoryHref("about-you/profile.md")).toBe("/memories/about-you/profile.md");
    expect(memoryHref("health/2026-11-23.md")).toBe("/memories/health/2026-11-23");
    expect(memoryHref("recordings/rec_testdemo.md")).toBe("/memories/recordings/rec_testdemo");
  });

  it("resolves the diary date route with or without .md to a single extension", () => {
    expect(memoryPathFromRoute({ date: "2026-11-23" }, "/memories/diaries/2026-11-23")).toBe(
      "diaries/2026-11-23.md",
    );
    expect(memoryPathFromRoute({ date: "2026-11-23.md" }, "/memories/diaries/2026-11-23.md")).toBe(
      "diaries/2026-11-23.md",
    );
    expect(memoryPathFromRoute({ date: "2026-11-23.md" }, "/memories/diaries/2026-11-23.md")).not.toContain(
      ".md.md",
    );
  });
});
