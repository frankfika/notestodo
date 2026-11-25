import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  ABOUT_MD_PATH,
  ABOUT_YOU_FILENAMES,
  CORE_ABOUT_YOU_FILES,
  MEMORY_SUBDIRS,
  isCoreAboutYouFile,
} from "@huoye/config";
import {
  ID_PREFIXES,
  formatIso,
  nowIso,
  type MemoryActivity,
  type MemoryFile,
  type MemorySearchHit,
  type MemoryTreeNode,
  type Provenance,
} from "@huoye/schema";
import {
  MemoryConflictError,
  MemoryNotFoundError,
  MemoryPathError,
  MemoryPermissionError,
} from "./errors";
import {
  inferKind,
  inferTitle,
  isBodyEmpty,
  parseFrontmatter,
  snippetOf,
  stringifyFrontmatter,
} from "./frontmatter";
import { newId } from "./ids";
import { resolveSafe } from "./paths";
import { revisionFor } from "./revision";

const ABOUT_HEADER = "由活页根据 about-you/ 生成，请改源文件。";
const ABOUT_HEADER_COMMENT = `<!-- ${ABOUT_HEADER} -->`;

export interface MemoryStoreOptions {
  memoryRoot: string;
  seedDir?: string;
  timezone?: string;
}

export class MemoryStore {
  readonly memoryRoot: string;
  readonly seedDir?: string;
  readonly timezone: string;
  private readonly useGit: boolean;

  constructor(options: MemoryStoreOptions) {
    this.memoryRoot = options.memoryRoot;
    this.seedDir = options.seedDir;
    this.timezone = options.timezone ?? "Asia/Shanghai";
    mkdirSync(this.memoryRoot, { recursive: true });
    this.useGit = canUseGit(this.memoryRoot);
  }

  seed(): void {
    for (const dir of MEMORY_SUBDIRS) {
      mkdirSync(path.join(this.memoryRoot, dir), { recursive: true });
    }
    if (this.seedDir) {
      for (const file of CORE_ABOUT_YOU_FILES) {
        const dest = path.join(this.memoryRoot, file);
        if (!existsSync(dest)) {
          const src = path.join(this.seedDir, file);
          mkdirSync(path.dirname(dest), { recursive: true });
          if (existsSync(src)) {
            copyFileSync(src, dest);
          } else {
            writeFileSync(dest, defaultCoreFile(file, this.timezone), "utf8");
          }
        }
      }
    } else {
      for (const file of CORE_ABOUT_YOU_FILES) {
        const dest = path.join(this.memoryRoot, file);
        if (!existsSync(dest)) {
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, defaultCoreFile(file, this.timezone), "utf8");
        }
      }
    }
    const pins = path.join(this.memoryRoot, "pins.json");
    if (!existsSync(pins)) writeFileSync(pins, "[]\n", "utf8");
    this.regenerateAboutMd();
    this.initVersioning();
  }

  listTree(): MemoryTreeNode[] {
    return readDir(this.memoryRoot, this.memoryRoot, this.readPins());
  }

  listFolder(relativePath: string): MemoryTreeNode {
    const { absolute, relative } = resolveSafe(this.memoryRoot, relativePath);
    if (!existsSync(absolute)) {
      throw new MemoryNotFoundError(`找不到：${relative}`);
    }
    if (!statSync(absolute).isDirectory()) {
      throw new MemoryPathError(`不是文件夹：${relative}`);
    }
    return {
      type: "dir",
      name: path.basename(absolute),
      relativePath: relative,
      children: readDir(this.memoryRoot, absolute, this.readPins()),
    };
  }

  readFile(relativePath: string): MemoryFile {
    const { absolute, relative } = resolveSafe(this.memoryRoot, relativePath);
    if (relative === ABOUT_MD_PATH) {
      this.regenerateAboutMd();
    }
    if (!existsSync(absolute) || statSync(absolute).isDirectory()) {
      throw new MemoryNotFoundError(`找不到记忆文件：${relative}`);
    }
    return toMemoryFile(absolute, relative, this.readPins(), this.timezone);
  }

  writeFile(
    relativePath: string,
    content: string,
    expectedRevision: string,
    actor: Provenance = "owner",
  ): MemoryFile {
    const { absolute, relative } = resolveSafe(this.memoryRoot, relativePath);
    if (relative === ABOUT_MD_PATH) {
      throw new MemoryPermissionError("ABOUT.md 由活页根据 about-you/ 生成，不可直接编辑");
    }
    if (inferKind(relative) === "system_summary" && relative !== ABOUT_MD_PATH) {
      // 系统摘要对用户只读；agent 可以覆盖 briefs/（例如再整理一版简报）。
      const existing = existsSync(absolute) ? toMemoryFile(absolute, relative, this.readPins(), this.timezone) : null;
      if (existing?.readonly && actor !== "agent") {
        throw new MemoryPermissionError("由活页生成，不可直接编辑");
      }
    }
    mkdirSync(path.dirname(absolute), { recursive: true });
    const existed = existsSync(absolute);
    if (existed) {
      const current = toMemoryFile(absolute, relative, this.readPins(), this.timezone);
      if (current.revision !== expectedRevision) {
        throw new MemoryConflictError(
          "文件在保存前已被修改",
          { revision: current.revision, snippet: snippetOf(current.content), content: current.content },
          { expectedRevision, snippet: snippetOf(content), content },
        );
      }
      const parsed = parseFrontmatter(content);
      const fm = { ...current.frontmatter, ...parsed.frontmatter };
      fm.id = current.id;
      fm.kind = inferKind(relative, fm.kind);
      fm.title = inferTitle(relative, fm, parsed.body);
      fm.updatedAt = nowIso(this.timezone);
      if (typeof fm.createdAt !== "string") fm.createdAt = current.createdAt;
      fm.readonly = relative === ABOUT_MD_PATH || fm.readonly === true;
      const next = stringifyFrontmatter(fm, parsed.body);
      writeFileSync(absolute, next, "utf8");
    } else {
      if (expectedRevision !== "") {
        throw new MemoryConflictError(
          "创建新文件时 expectedRevision 必须为空字符串",
          { revision: "", snippet: "", content: "" },
          { expectedRevision, snippet: snippetOf(content), content },
        );
      }
      const parsed = parseFrontmatter(content);
      const fm: Record<string, unknown> = { ...parsed.frontmatter };
      fm.id = typeof fm.id === "string" && fm.id ? fm.id : newId(ID_PREFIXES.memory);
      fm.kind = inferKind(relative, fm.kind);
      fm.title = inferTitle(relative, fm, parsed.body);
      fm.pinned = fm.pinned === true;
      fm.readonly = fm.readonly === true;
      fm.createdAt = typeof fm.createdAt === "string" ? fm.createdAt : nowIso(this.timezone);
      fm.updatedAt = nowIso(this.timezone);
      writeFileSync(absolute, stringifyFrontmatter(fm, parsed.body), "utf8");
    }
    const saved = toMemoryFile(absolute, relative, this.readPins(), this.timezone);
    this.recordActivity({
      actor,
      op: existed ? "update" : "create",
      path: relative,
      revision: saved.revision,
      message: `保存 ${relative}`,
    });
    if (relative.startsWith("about-you/")) this.regenerateAboutMd();
    this.commitIfGit(`保存 ${relative}`);
    return this.readFile(relative);
  }

  setProfileDisplayName(name: string): MemoryFile | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const file = this.readFile("about-you/profile.md");
    const next = upsertProfileNameLine(file.content, trimmed);
    if (next === file.content) return file;
    return this.writeFile("about-you/profile.md", next, file.revision, "owner");
  }

  mkdir(relativePath: string): void {
    const { absolute, relative } = resolveSafe(this.memoryRoot, relativePath);
    mkdirSync(absolute, { recursive: true });
    this.recordActivity({
      actor: "owner",
      op: "create",
      path: relative,
      message: `新建文件夹 ${relative}`,
    });
    this.commitIfGit(`新建文件夹 ${relative}`);
  }

  rename(fromPath: string, toPath: string): void {
    const from = resolveSafe(this.memoryRoot, fromPath);
    const to = resolveSafe(this.memoryRoot, toPath);
    if (isCoreAboutYouFile(from.relative) || isCoreAboutYouFile(to.relative)) {
      throw new MemoryPermissionError("五个核心画像文件不得改名");
    }
    if (from.relative === ABOUT_MD_PATH || to.relative === ABOUT_MD_PATH) {
      throw new MemoryPermissionError("ABOUT.md 不得改名");
    }
    if (!existsSync(from.absolute)) throw new MemoryNotFoundError(`找不到：${from.relative}`);
    if (existsSync(to.absolute)) throw new MemoryPermissionError(`目标已存在：${to.relative}`);
    mkdirSync(path.dirname(to.absolute), { recursive: true });
    renameSync(from.absolute, to.absolute);
    this.recordActivity({
      actor: "owner",
      op: "rename",
      path: to.relative,
      message: `重命名 ${from.relative} → ${to.relative}`,
    });
    this.commitIfGit(`重命名 ${from.relative} → ${to.relative}`);
  }

  deleteFile(relativePath: string): void {
    const { absolute, relative } = resolveSafe(this.memoryRoot, relativePath);
    if (isCoreAboutYouFile(relative) || relative === ABOUT_MD_PATH) {
      throw new MemoryPermissionError("五个核心画像文件不得删除");
    }
    if (!existsSync(absolute)) throw new MemoryNotFoundError(`找不到：${relative}`);
    rmSync(absolute, { recursive: true, force: true });
    this.recordActivity({
      actor: "owner",
      op: "delete",
      path: relative,
      message: `删除 ${relative}`,
    });
    this.commitIfGit(`删除 ${relative}`);
  }

  pin(relativePath: string, pinned: boolean): MemoryFile {
    const file = this.readFile(relativePath);
    const pins = new Set(this.readPins());
    if (pinned) pins.add(file.relativePath);
    else pins.delete(file.relativePath);
    writeFileSync(path.join(this.memoryRoot, "pins.json"), `${JSON.stringify([...pins], null, 2)}\n`, "utf8");
    const { absolute } = resolveSafe(this.memoryRoot, file.relativePath);
    if (existsSync(absolute) && !statSync(absolute).isDirectory()) {
      const raw = readFileSync(absolute, "utf8");
      const parsed = parseFrontmatter(raw);
      parsed.frontmatter.pinned = pinned;
      writeFileSync(absolute, stringifyFrontmatter(parsed.frontmatter, parsed.body), "utf8");
    }
    this.recordActivity({
      actor: "owner",
      op: "pin",
      path: file.relativePath,
      message: pinned ? `置顶 ${file.relativePath}` : `取消置顶 ${file.relativePath}`,
    });
    return this.readFile(file.relativePath);
  }

  composeAboutYou(): { markdown: string; files: MemoryFile[] } {
    const files: MemoryFile[] = [];
    const aboutDir = path.join(this.memoryRoot, "about-you");
    const extras: string[] = [];
    if (existsSync(aboutDir)) {
      for (const name of readdirSync(aboutDir)) {
        if (!name.endsWith(".md")) continue;
        if ((ABOUT_YOU_FILENAMES as readonly string[]).includes(name)) continue;
        extras.push(name);
      }
    }
    extras.sort((a, b) => a.localeCompare(b, "en"));
    const ordered = [...ABOUT_YOU_FILENAMES, ...extras];
    const parts: string[] = [ABOUT_HEADER_COMMENT, ""];
    for (const name of ordered) {
      const relative = `about-you/${name}`;
      const absolute = path.join(this.memoryRoot, relative);
      if (!existsSync(absolute) || statSync(absolute).isDirectory()) continue;
      const file = toMemoryFile(absolute, relative, this.readPins(), this.timezone);
      if (isBodyEmpty(parseFrontmatter(file.content).body)) continue;
      files.push(file);
      const body = stripLeadingTitle(parseFrontmatter(file.content).body, file.title);
      parts.push(`## ${file.title}`, "", body, "");
    }
    return { markdown: `${parts.join("\n").trim()}\n`, files };
  }

  regenerateAboutMd(): MemoryFile {
    const composed = this.composeAboutYou();
    const absolute = path.join(this.memoryRoot, ABOUT_MD_PATH);
    const existing = existsSync(absolute)
      ? parseFrontmatter(readFileSync(absolute, "utf8"))
      : { frontmatter: {} as Record<string, unknown>, body: "" };
    const fm: Record<string, unknown> = {
      ...existing.frontmatter,
      id: typeof existing.frontmatter.id === "string" ? existing.frontmatter.id : "mem_about_overview",
      title: "关于你",
      kind: "system_summary",
      pinned: false,
      readonly: true,
      createdAt:
        typeof existing.frontmatter.createdAt === "string"
          ? existing.frontmatter.createdAt
          : nowIso(this.timezone),
      updatedAt: nowIso(this.timezone),
    };
    writeFileSync(absolute, stringifyFrontmatter(fm, composed.markdown), "utf8");
    return toMemoryFile(absolute, ABOUT_MD_PATH, this.readPins(), this.timezone);
  }

  appendDiary(input: {
    date?: string;
    fact: string;
    sourceLabel?: string;
    sourceRef?: string;
    actor?: Provenance;
  }): MemoryFile {
    const date = input.date ?? todayInZone(this.timezone);
    const relative = `diaries/${date}.md`;
    const { absolute } = resolveSafe(this.memoryRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const time = timeInZone(this.timezone);
    const label = input.sourceLabel ?? "来自聊天";
    const blockLines = [`## ${time} · ${label}`, "", `- ${input.fact}`];
    if (input.sourceRef) blockLines.push(`- 出处：${input.sourceRef}`);
    blockLines.push("");
    const block = `${blockLines.join("\n")}\n`;
    if (!existsSync(absolute)) {
      const fm = {
        id: newId(ID_PREFIXES.memory),
        title: `${date} 的日记`,
        kind: "diary",
        pinned: false,
        readonly: false,
        createdAt: nowIso(this.timezone),
        updatedAt: nowIso(this.timezone),
      };
      writeFileSync(absolute, stringifyFrontmatter(fm, block), "utf8");
    } else {
      const raw = readFileSync(absolute, "utf8");
      const parsed = parseFrontmatter(raw);
      parsed.frontmatter.updatedAt = nowIso(this.timezone);
      const body = `${parsed.body.replace(/\n*$/, "\n")}\n${block}`;
      writeFileSync(absolute, stringifyFrontmatter(parsed.frontmatter, body), "utf8");
    }
    const saved = toMemoryFile(absolute, relative, this.readPins(), this.timezone);
    this.recordActivity({
      actor: input.actor ?? "agent",
      op: "update",
      path: relative,
      revision: saved.revision,
      message: `追加日记 ${relative}`,
    });
    this.commitIfGit(`追加日记 ${relative}`);
    return this.readFile(relative);
  }

  appendHealthNote(input: {
    date?: string;
    sleep?: string;
    movement?: string;
    mood?: string;
    note?: string;
    sourceLabel?: string;
    sourceRef?: string;
    actor?: Provenance;
  }): MemoryFile {
    const fields = healthFields(input);
    if (fields.length === 0) {
      throw new MemoryPathError("请至少写一项健康记录");
    }
    const date = input.date ?? todayInZone(this.timezone);
    const relative = healthRelativePath(date);
    const { absolute } = resolveSafe(this.memoryRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const time = timeInZone(this.timezone);
    const label = input.sourceLabel ?? "手记";
    const blockLines = [`## ${time} · ${label}`, ""];
    for (const field of fields) {
      blockLines.push(`- ${field.label}：${field.value}`);
    }
    blockLines.push(`- 出处：${input.sourceRef ?? "health:hand"}`);
    blockLines.push("");
    const block = `${blockLines.join("\n")}\n`;
    if (!existsSync(absolute)) {
      const fm = {
        id: newId(ID_PREFIXES.memory),
        title: `${date} 的健康记录`,
        kind: "other",
        pinned: false,
        readonly: false,
        createdAt: nowIso(this.timezone),
        updatedAt: nowIso(this.timezone),
      };
      writeFileSync(absolute, stringifyFrontmatter(fm, block), "utf8");
    } else {
      const raw = readFileSync(absolute, "utf8");
      const parsed = parseFrontmatter(raw);
      parsed.frontmatter.createdAt = coerceTimestamp(parsed.frontmatter.createdAt, this.timezone);
      parsed.frontmatter.updatedAt = nowIso(this.timezone);
      parsed.frontmatter.readonly = false;
      if (parsed.frontmatter.kind === "system_summary") parsed.frontmatter.kind = "other";
      const body = `${parsed.body.replace(/\n*$/, "\n")}\n${block}`;
      writeFileSync(absolute, stringifyFrontmatter(parsed.frontmatter, body), "utf8");
    }
    const saved = toMemoryFile(absolute, relative, this.readPins(), this.timezone);
    this.recordActivity({
      actor: input.actor ?? "owner",
      op: "update",
      path: relative,
      revision: saved.revision,
      message: `追加健康记录 ${relative}`,
    });
    this.commitIfGit(`追加健康记录 ${relative}`);
    return this.readFile(relative);
  }

  readHealthNote(date?: string): MemoryFile | null {
    const day = date ?? todayInZone(this.timezone);
    const relative = healthRelativePath(day);
    const { absolute } = resolveSafe(this.memoryRoot, relative);
    if (!existsSync(absolute) || statSync(absolute).isDirectory()) return null;
    return this.readFile(relative);
  }

  listHealthNotes(): MemoryFile[] {
    return listMarkdownFiles(this, "health").sort((a, b) => b.relativePath.localeCompare(a.relativePath));
  }

  writeRecordingNote(input: {
    id: string;
    title?: string;
    originalName: string;
    body: string;
    status: "transcribed" | "failed";
    error?: string;
    source?: "upload" | "browser";
    mimeType?: string;
    audioExt?: string;
    actor?: Provenance;
  }): MemoryFile {
    const relative = recordingRelativePath(input.id);
    const { absolute } = resolveSafe(this.memoryRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const existed = existsSync(absolute);
    const existing = existed ? parseFrontmatter(readFileSync(absolute, "utf8")) : null;
    const title = (input.title ?? existing?.frontmatter.title ?? recordingTitle(input.originalName)).toString();
    const fm: Record<string, unknown> = {
      ...existing?.frontmatter,
      id: typeof existing?.frontmatter.id === "string" ? existing.frontmatter.id : newId(ID_PREFIXES.memory),
      title,
      kind: "other",
      pinned: false,
      readonly: false,
      recordingId: input.id,
      originalName: input.originalName,
      status: input.status,
      source: input.source ?? "upload",
      createdAt:
        typeof existing?.frontmatter.createdAt === "string"
          ? existing.frontmatter.createdAt
          : nowIso(this.timezone),
      updatedAt: nowIso(this.timezone),
    };
    if (input.mimeType) fm.mimeType = input.mimeType;
    if (input.audioExt) fm.audioExt = input.audioExt;
    if (input.error) fm.error = input.error;
    else delete fm.error;
    const content = stringifyFrontmatter(fm, input.body.replace(/\n*$/, "\n"));
    const revision = existed ? toMemoryFile(absolute, relative, this.readPins(), this.timezone).revision : "";
    return this.writeFile(relative, content, revision, input.actor ?? "owner");
  }

  readRecordingNote(id: string): MemoryFile | null {
    const relative = recordingRelativePath(id);
    const { absolute } = resolveSafe(this.memoryRoot, relative);
    if (!existsSync(absolute) || statSync(absolute).isDirectory()) return null;
    return this.readFile(relative);
  }

  listRecordingNotes(): MemoryFile[] {
    return listMarkdownFiles(this, "recordings").sort((a, b) => {
      const byTime = b.createdAt.localeCompare(a.createdAt);
      return byTime !== 0 ? byTime : b.relativePath.localeCompare(a.relativePath);
    });
  }

    /**
   * 落盘一份简报。同一天同一时段覆盖上一份。
   */
  writeBrief(input: {
    date: string;
    slot: "morning" | "evening";
    text: string;
    generatedAt: string;
    source: string;
    label?: string;
  }): MemoryFile {
    const relative = briefRelativePath(input.date, input.slot);
    const { absolute } = resolveSafe(this.memoryRoot, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const existed = existsSync(absolute);
    const period = input.label ?? (input.slot === "evening" ? "晚间" : "早间");
    const title = `${input.date} ${period}简报`;
    const fm = {
      title,
      kind: "system_summary",
      slot: input.slot,
      generatedAt: input.generatedAt,
      source: input.source,
    };
    const content = stringifyFrontmatter(fm, input.text);
    const revision = existed ? toMemoryFile(absolute, relative, this.readPins(), this.timezone).revision : "";
    return this.writeFile(relative, content, revision, "agent");
  }

  /**
   * 读最近一份已落盘简报：先今天当前时段，再今天另一时段，最后最近一份。
   */
  readLatestBrief(
    now = new Date(),
    slot: "morning" | "evening" = "morning",
  ): { path: string; text: string; generatedAt: string; slot: "morning" | "evening" } | null {
    const dir = path.join(this.memoryRoot, "briefs");
    if (!existsSync(dir)) return null;
    const today = dateInZone(now, this.timezone);
    const other: "morning" | "evening" = slot === "morning" ? "evening" : "morning";
    const candidates = [
      briefRelativePath(today, slot),
      briefRelativePath(today, other),
    ];
    const names = readdirSync(dir).filter((name) => name.endsWith(".md"));
    const newest = names.reduce((best, name) => (name > best ? name : best), "");
    const files = newest ? [`briefs/${newest}`] : [];
    for (const relative of [...candidates, ...files]) {
      const { absolute } = resolveSafe(this.memoryRoot, relative);
      if (!existsSync(absolute)) continue;
      const parsed = parseFrontmatter(readFileSync(absolute, "utf8"));
      const generatedAt = coerceTimestamp(parsed.frontmatter.generatedAt, this.timezone);
      const rawSlot = parsed.frontmatter.slot === "evening" ? "evening" : "morning";
      return { path: relative, text: parsed.body.trim(), generatedAt, slot: rawSlot };
    }
    return null;
  }

  search(query: string): MemorySearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const hits: MemorySearchHit[] = [];
    walkFiles(this.memoryRoot, this.memoryRoot, (absolute, relative) => {
      if (relative === "pins.json") return;
      if (!relative.endsWith(".md") && !relative.endsWith(".txt")) return;
      const raw = readFileSync(absolute, "utf8");
      const parsed = parseFrontmatter(raw);
      const title = inferTitle(relative, parsed.frontmatter, parsed.body);
      const hay = `${title}\n${parsed.body}\n${relative}`;
      const index = hay.toLowerCase().indexOf(q.toLowerCase());
      if (index < 0) return;
      const start = Math.max(0, index - 40);
      hits.push({
        path: relative,
        title,
        snippet: snippetOf(hay.slice(start, start + 160)),
        score: title.toLowerCase().includes(q.toLowerCase()) ? 2 : 1,
      });
    });
    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return hits;
  }

  listActivities(limit = 50, cursor?: string): { items: MemoryActivity[]; nextCursor?: string } {
    const all = this.readActivities();
    let start = 0;
    if (cursor) {
      const idx = all.findIndex((a) => a.cursor === cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const items = all.slice(start, start + limit);
    const last = items[items.length - 1];
    const nextCursor = start + items.length < all.length && last ? last.cursor : undefined;
    return { items, nextCursor };
  }

  private readPins(): string[] {
    const p = path.join(this.memoryRoot, "pins.json");
    if (!existsSync(p)) return [];
    try {
      const data = JSON.parse(readFileSync(p, "utf8")) as unknown;
      return Array.isArray(data) ? data.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private activitiesPath(): string {
    return path.join(this.memoryRoot, "activities", "log.jsonl");
  }

  private readActivities(): MemoryActivity[] {
    const p = this.activitiesPath();
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const items: MemoryActivity[] = [];
    for (const line of lines) {
      try {
        items.push(JSON.parse(line) as MemoryActivity);
      } catch {
        // skip bad line
      }
    }
    items.reverse();
    return items;
  }

  recordActivity(input: {
    actor: Provenance;
    op: MemoryActivity["op"];
    path: string;
    revision?: string;
    message: string;
  }): void {
    mkdirSync(path.join(this.memoryRoot, "activities"), { recursive: true });
    const id = newId(ID_PREFIXES.activity);
    const activity: MemoryActivity = {
      id,
      at: nowIso(this.timezone),
      actor: input.actor,
      op: input.op,
      path: input.path,
      revision: input.revision,
      message: input.message,
      cursor: id,
    };
    const snapshot = path.join(this.memoryRoot, "activities", `${id}.json`);
    writeFileSync(snapshot, `${JSON.stringify(activity, null, 2)}\n`, "utf8");
    const log = this.activitiesPath();
    const prev = existsSync(log) ? readFileSync(log, "utf8") : "";
    writeFileSync(log, `${prev}${JSON.stringify(activity)}\n`, "utf8");
  }

  private initVersioning(): void {
    if (!this.useGit) return;
    const gitDir = path.join(this.memoryRoot, ".git");
    if (!existsSync(gitDir)) {
      try {
        execFileSync("git", ["init"], { cwd: this.memoryRoot, stdio: "ignore" });
        this.commitIfGit("初始记忆");
      } catch {
        // 无 git 时降级为 activities 快照
      }
    }
  }

  private commitIfGit(message: string): void {
    if (!this.useGit || !existsSync(path.join(this.memoryRoot, ".git"))) return;
    try {
      execFileSync("git", ["add", "-A"], { cwd: this.memoryRoot, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Huoye", "-c", "user.email=huoye@local", "commit", "-m", message, "--allow-empty-message"],
        { cwd: this.memoryRoot, stdio: "ignore" },
      );
    } catch {
      // 没有变更时 commit 会失败，忽略
    }
  }
}

function canUseGit(cwd: string): boolean {
  try {
    execFileSync("git", ["--version"], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function defaultCoreFile(relative: string, timezone: string): string {
  const titles: Record<string, string> = {
    "about-you/profile.md": "基本档案",
    "about-you/identity.md": "自我认同",
    "about-you/lifestyle.md": "生活习惯",
    "about-you/work.md": "工作与项目",
    "about-you/devices.md": "设备与工具",
  };
  const title = titles[relative] ?? relative;
  const fm = {
    id: newId(ID_PREFIXES.memory),
    title,
    kind: "about_you",
    pinned: false,
    readonly: false,
    createdAt: nowIso(timezone),
    updatedAt: nowIso(timezone),
  };
  return stringifyFrontmatter(fm, `# ${title}\n\n`);
}

function toMemoryFile(absolute: string, relative: string, pins: string[], timezone: string): MemoryFile {
  const raw = readFileSync(absolute, "utf8");
  const parsed = parseFrontmatter(raw);
  const kind = inferKind(relative, parsed.frontmatter.kind);
  const readonly = relative === ABOUT_MD_PATH || kind === "system_summary" || parsed.frontmatter.readonly === true;
  const id =
    typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id
      ? parsed.frontmatter.id
      : newId(ID_PREFIXES.memory);
  const createdAt =
    typeof parsed.frontmatter.createdAt === "string" ? parsed.frontmatter.createdAt : nowIso(timezone);
  const updatedAt =
    typeof parsed.frontmatter.updatedAt === "string"
      ? parsed.frontmatter.updatedAt
      : statSync(absolute).mtime.toISOString();
  return {
    id,
    relativePath: relative,
    title: inferTitle(relative, parsed.frontmatter, parsed.body),
    kind,
    pinned: pins.includes(relative) || parsed.frontmatter.pinned === true,
    readonly,
    content: raw,
    frontmatter: parsed.frontmatter,
    revision: revisionFor(absolute, raw),
    bytes: Buffer.byteLength(raw, "utf8"),
    createdAt,
    updatedAt,
  };
}

function readDir(root: string, current: string, pins: string[]): MemoryTreeNode[] {
  const entries = readdirSync(current, { withFileTypes: true })
    .filter((e) => e.name !== ".git" && e.name !== "pins.json")
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, "en");
    });
  const nodes: MemoryTreeNode[] = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      nodes.push({
        type: "dir",
        name: entry.name,
        relativePath: relative,
        children: readDir(root, absolute, pins),
      });
    } else {
      const file = toMemoryFile(absolute, relative, pins, "Asia/Shanghai");
      nodes.push({
        type: "file",
        name: entry.name,
        relativePath: relative,
        kind: file.kind,
        pinned: file.pinned,
        readonly: file.readonly,
      });
    }
  }
  return nodes;
}

function walkFiles(root: string, current: string, visit: (absolute: string, relative: string) => void): void {
  if (!existsSync(current)) return;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (entry.isDirectory()) walkFiles(root, absolute, visit);
    else visit(absolute, relative);
  }
}


function upsertProfileNameLine(content: string, name: string): string {
  const line = `- 称呼：${name}`;
  if (/^- 称呼：.*$/m.test(content)) return content.replace(/^- 称呼：.*$/m, line);
  if (/^# /m.test(content)) return content.replace(/^# .*$/m, (heading) => `${heading}\n\n${line}`);
  return `${content.trimEnd()}\n\n${line}\n`;
}

function coerceTimestamp(value: unknown, timeZone: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return formatIso(value, timeZone);
  return nowIso(timeZone);
}

export function briefRelativePath(date: string, slot: "morning" | "evening"): string {
  return `briefs/${date}-${slot}.md`;
}


export function healthRelativePath(date: string): string {
  return `health/${date}.md`;
}

export function recordingRelativePath(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean) throw new MemoryPathError("录音编号无效");
  return `recordings/${clean}.md`;
}

export function summarizeHealthNote(content: string): string[] {
  const facts: string[] = [];
  const body = parseFrontmatter(content ?? "").body || content || "";
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*[-*]\s+([^：:]+)[：:]\s*(.+)$/);
    if (!match) continue;
    const field = match[1].trim();
    const value = match[2].trim();
    if (!field || !value) continue;
    if (field === "出处") continue;
    facts.push(`${field}：${value}`);
  }
  return facts;
}

/** 取出当天健康手记里最近的一节（最后一个 ## 标题之后），没有标题则用全文。 */
export function latestHealthNoteBody(content: string): string {
  const body = parseFrontmatter(content ?? "").body || content || "";
  const parts = body.split(/(?=^##\s)/m).map((part) => part.trim()).filter(Boolean);
  return parts.at(-1) ?? body;
}

export function healthCardSummary(content: string, max = 80): string {
  const facts = summarizeHealthNote(latestHealthNoteBody(content));
  const order = ["睡眠", "活动", "心情", "备注"];
  const byField = new Map<string, string>();
  const extras: string[] = [];
  for (const item of facts) {
    const field = item.match(/^([^：:]+)[：:]/)?.[1]?.trim() ?? "";
    const value = item.replace(/^[^：:]+[：:]\s*/, "").trim();
    if (!value) continue;
    if (order.includes(field)) byField.set(field, value);
    else extras.push(value);
  }
  const compact = [...order.map((field) => byField.get(field)).filter((item): item is string => Boolean(item)), ...extras];
  const text = compact.join(" · ");
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function healthFields(input: {
  sleep?: string;
  movement?: string;
  mood?: string;
  note?: string;
}): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const add = (label: string, value?: string) => {
    const trimmed = (value ?? "").trim();
    if (trimmed) out.push({ label, value: trimmed });
  };
  add("睡眠", input.sleep);
  add("活动", input.movement);
  add("心情", input.mood);
  add("备注", input.note);
  return out;
}

function recordingTitle(originalName: string): string {
  const base = path.basename(originalName).replace(/\.[^.]+$/, "").trim();
  return base || "一段录音";
}

function listMarkdownFiles(store: MemoryStore, folder: string): MemoryFile[] {
  const dir = path.join(store.memoryRoot, folder);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const pinsPath = path.join(store.memoryRoot, "pins.json");
  let pins: string[] = [];
  if (existsSync(pinsPath)) {
    try {
      const data = JSON.parse(readFileSync(pinsPath, "utf8")) as unknown;
      pins = Array.isArray(data) ? data.filter((x): x is string => typeof x === "string") : [];
    } catch {
      pins = [];
    }
  }
  const out: MemoryFile[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const relative = `${folder}/${name}`;
    const absolute = path.join(dir, name);
    if (!statSync(absolute).isFile()) continue;
    out.push(toMemoryFile(absolute, relative, pins, store.timezone));
  }
  return out;
}


function todayInZone(timeZone: string): string {
  return dateInZone(new Date(), timeZone);
}

function dateInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function timeInZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}


function stripLeadingTitle(body: string, title: string): string {
  const trimmed = (body ?? "").trim();
  if (!title) return trimmed;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return trimmed.replace(new RegExp(`^#+\\s*${escaped}\\s*(?:\\n+|$)`), "").trim();
}
