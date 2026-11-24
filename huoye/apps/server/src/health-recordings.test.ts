import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { listUsageEvents } from "@huoye/metering";
import { createApp } from "./app";
import { recordingAudioPath } from "./recordings";

function tempApp(options: { now?: () => Date; fetchImpl?: typeof fetch } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "huoye-health-"));
  const created = createApp({ home, now: options.now, fetchImpl: options.fetchImpl });
  return { app: created.app, workspace: created.workspace, home };
}

function silentWav(): Buffer {
  const sampleRate = 8000;
  const samples = 1600;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const now = () => new Date("2026-11-23T13:30:00+08:00");

const transcribeFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ text: "后天下午我要提前走。" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("@huoye/server health and recordings", () => {

  it("writes a health note, reads it back, and includes it in a local brief without fake usage", async () => {
    const { app, workspace } = tempApp({ now });
    const emptyCards = await app.request("/api/today/cards");
    const before = (await emptyCards.json()) as { health: { hasToday: boolean } };
    expect(before.health.hasToday).toBe(false);

    const rejected = await app.request("/api/health-notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(rejected.status).toBe(400);

    const created = await app.request("/api/health-notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sleep: "大约睡了 7 小时", movement: "走了半小时", mood: "平静" }),
    });
    expect(created.status).toBe(201);
    const saved = (await created.json()) as {
      today: { exists: boolean; path: string; summary: string; content: string };
      wearables: Array<{ status: string }>;
    };
    expect(saved.today.exists).toBe(true);
    expect(saved.today.path).toBe("health/2026-11-23.md");
    expect(saved.today.content).toContain("睡眠：大约睡了 7 小时");
    expect(saved.today.content).not.toContain("出处：");
    expect(saved.today.content).not.toMatch(/^---/m);
    expect(saved.today.content).not.toContain("kind:");
    expect(workspace.memory.readFile("health/2026-11-23.md").content).toContain("出处：health:hand");
    expect(saved.wearables.every((item) => item.status === "not_connected")).toBe(true);

    const listed = await app.request("/api/health-notes");
    const list = (await listed.json()) as {
      date: string;
      today: { exists: boolean; summary: string; content: string };
      items: Array<{ date: string; path: string }>;
    };
    expect(list.today.exists).toBe(true);
    expect(list.today.summary).toContain("大约睡了 7 小时");
    expect(list.today.content).not.toContain("createdAt:");
    expect(list.today.content.trimStart().startsWith("---")).toBe(false);
    expect(list.items.some((item) => item.date === list.date || item.path === "health/2026-11-23.md")).toBe(false);

    const cards = await app.request("/api/today/cards");
    const cardBody = (await cards.json()) as { health: { hasToday: boolean; summary: string } };
    expect(cardBody.health.hasToday).toBe(true);
    expect(cardBody.health.summary).toContain("走了半小时");

    const usageBefore = listUsageEvents(workspace.db, 50).length;
    const briefRes = await app.request("/api/today/brief", { method: "POST" });
    expect(briefRes.status).toBe(200);
    const brief = (await briefRes.json()) as { text: string; source: string };
    expect(brief.source).toBe("local");
    expect(brief.text).toContain("今天的健康记录里写了");
    expect(brief.text).toContain("大约睡了 7 小时");
    expect(brief.text).toContain("走了半小时");
    expect(brief.text).not.toContain("出处：health:hand");
    expect(brief.text).not.toContain("kind:");
    expect(listUsageEvents(workspace.db, 50)).toHaveLength(usageBefore);

    const zipRes = await app.request("/api/export/memory.zip");
    const zip = await JSZip.loadAsync(Buffer.from(await zipRes.arrayBuffer()));
    const entry = zip.file("health/2026-11-23.md");
    expect(entry).toBeTruthy();
    expect(await entry!.async("string")).toContain("心情：平静");
  });

  it("stores an uploaded recording and writes an honest note when speech is not configured", async () => {
    const { app, workspace } = tempApp({ now });
    const usageBefore = listUsageEvents(workspace.db, 50).length;
    const form = new FormData();
    form.set("file", new File([silentWav()], "desk.wav", { type: "audio/wav" }));
    const uploaded = await app.request("/api/recordings", { method: "POST", body: form });
    expect(uploaded.status).toBe(201);
    const body = (await uploaded.json()) as {
      item: {
        id: string;
        path: string;
        status: string;
        error?: string;
        content: string;
        title: string;
        durationMs: number | null;
        playable: boolean;
        bytes: number;
      };
      transcribe: { ok: boolean; unconfigured?: boolean; error?: string };
    };
    expect(body.transcribe.ok).toBe(false);
    expect(body.transcribe.unconfigured).toBe(true);
    expect(body.transcribe.error).toBe("还没有配置可用的语音转写");
    expect(body.item.status).toBe("failed");
    expect(body.item.error).toBe("还没有配置可用的语音转写");
    expect(body.item.content).toContain("还没有配置可用的语音转写");
    expect(body.item.content).not.toContain("出处：");
    expect(body.item.content).not.toMatch(/^---/m);
    expect(body.item.content).not.toContain("recordingId:");
    expect(body.item.content).not.toContain("createdAt:");
    expect(body.item.title).toBe("desk");
    expect(body.item.durationMs).toBe(200);
    expect(body.item.playable).toBe(true);
    expect(body.item.bytes).toBeGreaterThan(44);
    expect(existsSync(recordingAudioPath(workspace, body.item.id, "wav"))).toBe(true);
    expect(workspace.memory.readFile(body.item.path).content).toContain(`出处：recording:${body.item.id}`);

    const listed = await app.request("/api/recordings");
    const list = (await listed.json()) as {
      items: Array<{ id: string }>;
      transcribeConfigured: boolean;
      meetings: { status: string };
    };
    expect(list.transcribeConfigured).toBe(false);
    expect(list.meetings.status).toBe("not_connected");
    expect(list.items.some((item) => item.id === body.item.id)).toBe(true);

    const note = workspace.memory.readFile(body.item.path);
    expect(note.readonly).toBe(false);
    expect(note.content).toContain("你可以在这里补记这段录音的内容");

    const edited = await app.request(`/api/recordings/${body.item.id}/note`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: `${note.content}\n补记：桌边的一段谈话。\n`,
        expectedRevision: note.revision,
      }),
    });
    expect(edited.status).toBe(200);
    const after = (await edited.json()) as { item: { content: string } };
    expect(after.item.content).toContain("桌边的一段谈话");

    const audio = await app.request(`/api/recordings/${body.item.id}/audio`);
    expect(audio.status).toBe(200);
    expect(Buffer.from(await audio.arrayBuffer()).length).toBeGreaterThan(40);

    const cards = await app.request("/api/today/cards");
    const cardBody = (await cards.json()) as { recordings: { count: number; todayCount: number } };
    expect(cardBody.recordings.count).toBe(1);
    expect(cardBody.recordings.todayCount).toBe(1);
    expect(listUsageEvents(workspace.db, 50)).toHaveLength(usageBefore);

    const zipRes = await app.request("/api/export/memory.zip");
    const zip = await JSZip.loadAsync(Buffer.from(await zipRes.arrayBuffer()));
    expect(zip.file(body.item.path)).toBeTruthy();
  });

  it("writes a real transcript when a MiniMax speech key is already in the workspace", async () => {
    const { app, workspace } = tempApp({ now, fetchImpl: transcribeFetch });
    const settings = workspace.readSettings();
    workspace.writeSettings({
      providers: [
        ...settings.providers,
        {
          id: "mmx",
          type: "openai_compatible",
          name: "MiniMax",
          baseUrl: "https://api.minimax.cn/v1",
          modelId: "MiniMax-M2",
          hasApiKey: false,
        },
      ],
    });
    workspace.setProviderKey("mmx", "sk-test-not-real");

    const usageBefore = listUsageEvents(workspace.db, 50).length;
    const form = new FormData();
    form.set("file", new File([silentWav()], "leave.wav", { type: "audio/wav" }));
    const uploaded = await app.request("/api/recordings", { method: "POST", body: form });
    expect(uploaded.status).toBe(201);
    const body = (await uploaded.json()) as {
      item: { status: string; content: string; id: string };
      transcribe: { ok: boolean; text?: string };
    };
    expect(body.transcribe.ok).toBe(true);
    expect(body.item.status).toBe("transcribed");
    expect(body.item.content).toContain("后天下午我要提前走。");
    expect(body.item.content).not.toContain("出处：");
    expect(readFileSync(path.join(workspace.paths.memory, `recordings/${body.item.id}.md`), "utf8")).toContain(
      `出处：recording:${body.item.id}`,
    );
    expect(listUsageEvents(workspace.db, 50)).toHaveLength(usageBefore);
    expect(readFileSync(path.join(workspace.paths.memory, `recordings/${body.item.id}.md`), "utf8")).toContain(
      "后天下午我要提前走。",
    );
  });

  it("regenerates a brief after multiple health appends and includes the latest note", async () => {
    const { app, workspace } = tempApp({ now });
    const firstNote = await app.request("/api/health-notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sleep: "大约睡了 7 小时", movement: "走了半小时", mood: "平静" }),
    });
    expect(firstNote.status).toBe(201);
    const firstBrief = await app.request("/api/today/brief", { method: "POST" });
    expect(firstBrief.status).toBe(200);
    const first = (await firstBrief.json()) as { text: string; source: string };
    expect(first.source).toBe("local");
    expect(first.text).toContain("大约睡了 7 小时");

    const secondNote = await app.request("/api/health-notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sleep: "大约睡了 6 小时",
        movement: "下午散步 20 分钟",
        mood: "还好",
        note: "QA标记：health-ui-1",
      }),
    });
    expect(secondNote.status).toBe(201);
    const rawHealth = readFileSync(path.join(workspace.paths.memory, "health/2026-11-23.md"), "utf8");
    expect(rawHealth.startsWith("---")).toBe(true);
    expect(rawHealth).toContain("QA标记：health-ui-1");
    expect(rawHealth).toMatch(/createdAt: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    expect(rawHealth).not.toMatch(/createdAt: .*Z/);

    const usageBefore = listUsageEvents(workspace.db, 50).length;
    const listed = await app.request("/api/health-notes");
    const list = (await listed.json()) as { today: { summary: string; content: string } };
    expect(list.today.summary).toContain("大约睡了 6 小时");
    expect(list.today.summary).toContain("下午散步 20 分钟");
    expect(list.today.summary).not.toContain("7 小时");
    expect(list.today.content).toContain("大约睡了 7 小时");
    expect(list.today.content).toContain("下午散步 20 分钟");
    expect(list.today.content).not.toContain("出处：");
    const cards = await app.request("/api/today/cards");
    const cardBody = (await cards.json()) as { health: { summary: string } };
    expect(cardBody.health.summary).toContain("大约睡了 6 小时");
    expect(cardBody.health.summary).toContain("下午散步 20 分钟");
    expect(cardBody.health.summary).toContain("还好");
    expect(cardBody.health.summary).not.toContain("7 小时");
    expect(cardBody.health.summary).not.toContain("走了半小时");

    const secondBrief = await app.request("/api/today/brief", { method: "POST" });
    expect(secondBrief.status).toBe(200);
    const brief = (await secondBrief.json()) as { text: string; source: string };
    expect(brief.source).toBe("local");
    expect(brief.text).toContain("大约睡了 6 小时");
    expect(brief.text).toContain("下午散步 20 分钟");
    expect(brief.text).toContain("QA标记：health-ui-1");
    expect(brief.text).not.toContain("出处：health:hand");
    expect(brief.text).not.toContain("kind:");
    expect(listUsageEvents(workspace.db, 50)).toHaveLength(usageBefore);
  });

  it("returns human recording bodies and preserves metadata when the editor sends frontmatter", async () => {
    const { app, workspace } = tempApp({ now });
    const form = new FormData();
    form.set("file", new File([silentWav()], "desk.wav", { type: "audio/wav" }));
    const uploaded = await app.request("/api/recordings", { method: "POST", body: form });
    const body = (await uploaded.json()) as {
      item: { id: string; path: string; content: string; revision: string };
    };
    const onDisk = workspace.memory.readFile(body.item.path);
    const originalId = onDisk.id;
    const originalCreatedAt = onDisk.createdAt;
    expect(body.item.content).not.toContain("id:");
    expect(body.item.content).not.toMatch(/^---/m);

    const forged = `---
id: forged-id
recordingId: forged-rec
createdAt: 2020-01-01T00:00:00.000Z
title: forged-title
---

补记：桌边的一段谈话。
`;
    const edited = await app.request(`/api/recordings/${body.item.id}/note`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: forged, expectedRevision: body.item.revision }),
    });
    expect(edited.status).toBe(200);
    const after = (await edited.json()) as { item: { content: string; title: string; revision: string } };
    expect(after.item.content).toContain("补记：桌边的一段谈话。");
    expect(after.item.content).not.toContain("forged");
    expect(after.item.content).not.toMatch(/^---/m);
    expect(after.item.title).toBe("desk");
    const raw = readFileSync(path.join(workspace.paths.memory, body.item.path), "utf8");
    expect(raw).toContain(`id: ${originalId}`);
    expect(raw).toContain(`createdAt: ${originalCreatedAt}`);
    expect(raw).toContain(`recordingId: ${body.item.id}`);
    expect(raw).toContain(`出处：recording:${body.item.id}`);
    expect(after.item.content).not.toContain("出处：");
    expect(raw).not.toContain("forged-id");
    expect(raw).not.toContain("2020-01-01");

    const again = await app.request(`/api/recordings/${body.item.id}/note`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "只留下一句人话。", expectedRevision: after.item.revision }),
    });
    expect(again.status).toBe(200);
    const saved = (await again.json()) as { item: { content: string } };
    expect(saved.item.content).toContain("只留下一句人话。");
    expect(saved.item.content).not.toContain("出处：");
    const rawAgain = readFileSync(path.join(workspace.paths.memory, body.item.path), "utf8");
    expect(rawAgain).toContain("只留下一句人话。");
    expect(rawAgain).toContain(`出处：recording:${body.item.id}`);
  });

});
