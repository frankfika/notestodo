import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(fileURLToPath(new URL("RecordingsPage.tsx", import.meta.url)), "utf8");
const apiSource = readFileSync(fileURLToPath(new URL("../lib/api.ts", import.meta.url)), "utf8");

describe("录音页的导入纪要入口", () => {
  it("仍然提供「导入并整理成纪要」按钮", () => {
    expect(pageSource).toContain("导入并整理成纪要");
  });

  it("这个入口仍然调用会议纪要接口 api.summarizeMeeting", () => {
    expect(pageSource).toContain("api.summarizeMeeting");
    expect(pageSource).toMatch(/api\.summarizeMeeting\(\{\s*transcript:/);
  });

  it("api 客户端仍然把 summarizeMeeting 指向 /api/meetings/summarize", () => {
    expect(apiSource).toContain("summarizeMeeting");
    expect(apiSource).toMatch(/summarizeMeeting:[\s\S]{0,200}?\/api\/meetings\/summarize/);
  });
});
