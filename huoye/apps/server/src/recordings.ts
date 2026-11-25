import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MAX_MEMORY_UPLOAD_BYTES } from "@huoye/config";
import {
  newId,
  resolveSpeechProvider,
  transcribeAudio,
  UNCONFIGURED_TRANSCRIBE_ERROR,
  type SpeechProvider,
  type TranscribeResult,
} from "@huoye/core";
import { healthCardSummary, humanMemoryBody } from "@huoye/memory";
import { inspectAudio } from "./audio-duration";
import { ID_PREFIXES, type MemoryFile } from "@huoye/schema";
import type { Workspace } from "./workspace";
import { dateInZone } from "./helpers";

const AUDIO_EXTS = new Set(["wav", "mp3", "m4a", "aac", "ogg", "opus", "flac", "webm", "aiff", "aif"]);

export function recordingsAudioDir(workspace: Workspace): string {
  return path.join(workspace.paths.data, "recordings");
}

export function recordingAudioPath(workspace: Workspace, id: string, ext: string): string {
  return path.join(recordingsAudioDir(workspace), `${id}.${ext}`);
}

export function resolveWorkspaceSpeechProvider(workspace: Workspace): SpeechProvider | null {
  const settings = workspace.readSettings();
  const keys: Record<string, string | undefined> = {};
  for (const provider of settings.providers) {
    keys[provider.id] = workspace.getProviderKey(provider.id);
  }
  return resolveSpeechProvider(settings.providers, keys);
}

export function healthNotesPayload(workspace: Workspace, now = new Date()) {
  const timeZone = workspace.readSettings().timezone || "Asia/Shanghai";
  const date = dateInZone(now, timeZone);
  const today = workspace.memory.readHealthNote(date);
  const items = workspace.memory
    .listHealthNotes()
    .filter((file) => file.relativePath !== `health/${date}.md`)
    .map(toHealthItem);
  return {
    date,
    today: today
      ? {
          date,
          exists: true as const,
          path: today.relativePath,
          title: today.title,
          summary: healthCardSummary(today.content),
          content: humanMemoryBody(today.content),
          revision: today.revision,
        }
      : { date, exists: false as const, path: `health/${date}.md`, summary: "", content: "" },
    items,
    wearables: [{ id: "wearable", name: "手表或健康应用", status: "not_connected" as const }],
  };
}

export function todayCardsPayload(workspace: Workspace, now = new Date()) {
  const timeZone = workspace.readSettings().timezone || "Asia/Shanghai";
  const date = dateInZone(now, timeZone);
  const today = workspace.memory.readHealthNote(date);
  const recordings = workspace.memory.listRecordingNotes().map((file) => toRecordingItem(file, workspace));
  const todayRecordings = recordings.filter((item) => item.createdAt.slice(0, 10) === date);
  const latest = recordings[0];
  return {
    health: {
      date,
      hasToday: Boolean(today),
      summary: today ? healthCardSummary(today.content) : "",
      path: today?.relativePath ?? `health/${date}.md`,
    },
    recordings: {
      count: recordings.length,
      todayCount: todayRecordings.length,
      latest: latest ?? null,
    },
    transcribeConfigured: Boolean(resolveWorkspaceSpeechProvider(workspace)),
  };
}

export async function saveUploadedRecording(input: {
  workspace: Workspace;
  bytes: Buffer;
  originalName: string;
  mimeType?: string;
  source?: "upload" | "browser";
  fetchImpl?: typeof fetch;
}): Promise<{ item: RecordingItem; transcribe: TranscribeResult }> {
  const ext = safeExt(input.originalName, input.mimeType);
  if (!ext) {
    throw new RecordingError("只支持常见的音频格式，比如 wav、mp3、m4a、ogg。", 400);
  }
  if (input.bytes.byteLength === 0) {
    throw new RecordingError("这个音频是空的。", 400);
  }
  if (input.bytes.byteLength > MAX_MEMORY_UPLOAD_BYTES) {
    throw new RecordingError("音频不能超过 50 MB。", 400);
  }
  const id = newId(ID_PREFIXES.recording);
  const dir = recordingsAudioDir(input.workspace);
  mkdirSync(dir, { recursive: true });
  const audioPath = recordingAudioPath(input.workspace, id, ext);
  writeFileSync(audioPath, input.bytes);

  const provider = resolveWorkspaceSpeechProvider(input.workspace);
  const transcribe = await transcribeAudio(provider, {
    bytes: input.bytes,
    fileName: input.originalName || `audio.${ext}`,
    mimeType: input.mimeType,
    language: "zh",
    fetchImpl: input.fetchImpl,
  });

  const body = recordingNoteBody(id, transcribe);
  const file = input.workspace.memory.writeRecordingNote({
    id,
    originalName: input.originalName || `audio.${ext}`,
    body,
    status: transcribe.ok ? "transcribed" : "failed",
    error: transcribe.ok ? undefined : transcribe.error,
    source: input.source ?? "upload",
    mimeType: input.mimeType,
    audioExt: ext,
    actor: "owner",
  });
  input.workspace.audit({
    actor: "user",
    type: transcribe.ok ? "recording.transcribed" : "recording.uploaded",
    summary: transcribe.ok ? `已转写录音 ${id}` : `已保存录音 ${id}`,
    refs: [file.relativePath, id],
  });
  return { item: toRecordingItem(file, input.workspace), transcribe };
}

export function readRecordingAudio(
  workspace: Workspace,
  id: string,
): { path: string; bytes: Buffer; mimeType: string; fileName: string } | null {
  const note = workspace.memory.readRecordingNote(id);
  if (!note) return null;
  const ext =
    typeof note.frontmatter.audioExt === "string" && note.frontmatter.audioExt
      ? note.frontmatter.audioExt
      : guessExt(String(note.frontmatter.originalName ?? ""));
  if (!ext || !AUDIO_EXTS.has(ext)) return null;
  const audioPath = recordingAudioPath(workspace, id, ext);
  if (!existsSync(audioPath)) return null;
  const mimeType =
    typeof note.frontmatter.mimeType === "string" && note.frontmatter.mimeType
      ? note.frontmatter.mimeType
      : "application/octet-stream";
  const fileName =
    typeof note.frontmatter.originalName === "string" && note.frontmatter.originalName
      ? note.frontmatter.originalName
      : `${id}.${ext}`;
  return { path: audioPath, bytes: readFileSync(audioPath), mimeType, fileName };
}

export function recordingsPayload(workspace: Workspace) {
  return {
    items: workspace.memory.listRecordingNotes().map((file) => toRecordingItem(file, workspace)),
    transcribeConfigured: Boolean(resolveWorkspaceSpeechProvider(workspace)),
    meetings: { status: "not_connected" as const, label: "会议软件还没有连接。" },
  };
}

export class RecordingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 = 400,
  ) {
    super(message);
    this.name = "RecordingError";
  }
}

export interface RecordingItem {
  id: string;
  title: string;
  originalName: string;
  status: "transcribed" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
  path: string;
  summary: string;
  content: string;
  revision: string;
  bytes: number;
  durationMs: number | null;
  playable: boolean;
  audioError?: string;
}

export interface HealthItem {
  date: string;
  path: string;
  title: string;
  summary: string;
  updatedAt: string;
}

function toHealthItem(file: MemoryFile): HealthItem {
  const date = file.relativePath.replace(/^health\//, "").replace(/\.md$/i, "");
  return {
    date,
    path: file.relativePath,
    title: file.title,
    summary: healthCardSummary(file.content),
    updatedAt: file.updatedAt,
  };
}

export function toRecordingItem(file: MemoryFile, workspace: Workspace): RecordingItem {
  const id =
    (typeof file.frontmatter.recordingId === "string" && file.frontmatter.recordingId) ||
    file.relativePath.replace(/^recordings\//, "").replace(/\.md$/i, "");
  const status = file.frontmatter.status === "transcribed" ? "transcribed" : "failed";
  const error = typeof file.frontmatter.error === "string" ? file.frontmatter.error : undefined;
  const originalName = typeof file.frontmatter.originalName === "string" ? file.frontmatter.originalName : "";
  const audio = readRecordingAudio(workspace, id);
  const ext =
    (typeof file.frontmatter.audioExt === "string" && file.frontmatter.audioExt) ||
    (originalName.split(".").pop() ?? "");
  const inspected = inspectAudio(audio?.bytes ?? null, ext);
  return {
    id,
    title: file.title,
    originalName,
    status,
    error,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    path: file.relativePath,
    summary: recordingSummary(file.content),
    content: humanMemoryBody(file.content),
    revision: file.revision,
    bytes: inspected.bytes,
    durationMs: inspected.durationMs,
    playable: inspected.playable,
    audioError: inspected.error,
  };
}

function recordingNoteBody(id: string, result: TranscribeResult): string {
  const provenance = `- 出处：recording:${id}`;
  if (result.ok) {
    return `## 转写\n\n${result.text}\n\n${provenance}\n`;
  }
  const lead = result.unconfigured ? UNCONFIGURED_TRANSCRIBE_ERROR : result.error;
  return `${lead}。音频已经保存在本机，你可以在这里补记这段录音的内容。\n\n${provenance}\n`.replace("。。", "。");
}

function recordingSummary(content: string): string {
  const body = humanMemoryBody(content).replace(/^##\s+转写\s*$/m, "");
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

function safeExt(name: string, mimeType?: string): string | null {
  const fromName = name.split(".").pop()?.toLowerCase() ?? "";
  if (AUDIO_EXTS.has(fromName)) return fromName === "aif" ? "aiff" : fromName;
  const fromMime: Record<string, string> = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/flac": "flac",
    "audio/webm": "webm",
    "audio/aiff": "aiff",
  };
  const mapped = mimeType ? fromMime[mimeType.split(";")[0]!.trim().toLowerCase()] : undefined;
  return mapped ?? null;
}

function guessExt(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}
