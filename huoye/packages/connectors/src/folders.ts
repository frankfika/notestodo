import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type LocalFolderStatus = "connected" | "error";
export type LocalFolderEntryKind = "file" | "directory" | "symlink" | "other";

export interface ConnectorStoreData {
  localFolders: string[];
}

export interface LocalFolderView {
  path: string;
  status: LocalFolderStatus;
  error?: string;
}

export interface LocalFolderEntry {
  name: string;
  kind: LocalFolderEntryKind;
  /** 符号链接指向已添加文件夹以外的位置，不会继续读取。 */
  outside?: boolean;
}

export interface LocalFolderListing {
  path: string;
  status: LocalFolderStatus;
  error?: string;
  entries: LocalFolderEntry[];
  /** 顶层条目超过上限时为 true，不会继续往下翻整棵目录树。 */
  truncated?: boolean;
}

export const TOP_LEVEL_LIST_LIMIT = 200;

export const FOLDER_ERROR = {
  empty: "请先填写一个具体的文件夹路径。空路径或单独的「~」不会被当成整个家目录。",
  home: "不能添加家目录、/home 或磁盘根目录。请选一个更具体的文件夹。",
  relative: "请填写完整的文件夹路径（以 / 开头，或使用「~/具体目录」）。相对路径不会按当前程序目录去猜。",
  missing: "这个目录不存在，活页不会把它标成已连接。",
  permission: "没有读取这个目录的权限。",
  notDir: "这不是一个文件夹。",
  notAttached: "这个文件夹还没有添加。",
  tooBroad: "这个路径范围太大，已被拒绝。请移除后改选更具体的文件夹。",
} as const;

export class FolderAttachError extends Error {
  constructor(
    message: string,
    readonly code: keyof typeof FOLDER_ERROR | "io",
  ) {
    super(message);
    this.name = "FolderAttachError";
  }
}

/**
 * 规范化用户填写的路径。单独的「~」或「$HOME」不会展开成家目录。
 * 只有写成「~/具体目录」时才会展开。
 */
export function normalizeFolderInput(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new FolderAttachError(FOLDER_ERROR.empty, "empty");
  }
  if (isBareHomeAlias(raw)) {
    throw new FolderAttachError(FOLDER_ERROR.home, "home");
  }
  if (raw.startsWith("~/")) {
    return path.resolve(path.join(os.homedir(), raw.slice(2)));
  }
  if (raw.startsWith("$HOME/")) {
    return path.resolve(path.join(os.homedir(), raw.slice("$HOME/".length)));
  }
  if (!path.isAbsolute(raw)) {
    throw new FolderAttachError(FOLDER_ERROR.relative, "relative");
  }
  return path.resolve(raw);
}

export function isBareHomeAlias(raw: string): boolean {
  const value = raw.trim();
  return (
    value === "~" ||
    value === "~/" ||
    value === "~/." ||
    value === "$HOME" ||
    value === "$HOME/" ||
    value === "${HOME}" ||
    value === "${HOME}/"
  );
}

export function isDisallowedRoot(resolved: string): boolean {
  const home = path.resolve(os.homedir());
  const normalized = path.resolve(resolved);
  if (normalized === home) return true;
  if (normalized === "/" || normalized === path.parse(normalized).root) return true;
  if (normalized === "/home" || normalized === "/Users" || normalized === "/root") return true;
  return false;
}

/** @deprecated 使用 isDisallowedRoot。保留别名以免旧引用立刻失效。 */
export function isHomeOrRoot(resolved: string): boolean {
  return isDisallowedRoot(resolved);
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const normRoot = path.resolve(root);
  const normCandidate = path.resolve(candidate);
  return normCandidate === normRoot || normCandidate.startsWith(normRoot + path.sep);
}

export function describeFolderFsError(error: unknown, fallback: string = FOLDER_ERROR.missing): { message: string; code: "missing" | "permission" | "notDir" | "io" } {
  if (error instanceof FolderAttachError) {
    const code = error.code === "missing" || error.code === "permission" || error.code === "notDir" ? error.code : "io";
    return { message: error.message, code };
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "ENOENT") return { message: FOLDER_ERROR.missing, code: "missing" };
    if (code === "EACCES" || code === "EPERM") return { message: FOLDER_ERROR.permission, code: "permission" };
    if (code === "ENOTDIR") return { message: FOLDER_ERROR.notDir, code: "notDir" };
  }
  return { message: fallback, code: "io" };
}

function assertAllowedRoot(resolved: string): void {
  if (isDisallowedRoot(resolved)) {
    throw new FolderAttachError(FOLDER_ERROR.home, "home");
  }
}

function resolveExistingFolder(resolved: string): string {
  let stats;
  try {
    stats = lstatSync(resolved);
  } catch (error) {
    const mapped = describeFolderFsError(error);
    throw new FolderAttachError(mapped.message, mapped.code);
  }
  if (stats.isSymbolicLink()) {
    let real: string;
    try {
      real = realpathSync(resolved);
    } catch (error) {
      const mapped = describeFolderFsError(error);
      throw new FolderAttachError(mapped.message, mapped.code);
    }
    assertAllowedRoot(real);
    assertReadableDirectory(real);
    return real;
  }
  if (!stats.isDirectory()) {
    throw new FolderAttachError(FOLDER_ERROR.notDir, "notDir");
  }
  assertReadableDirectory(resolved);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch (error) {
    const mapped = describeFolderFsError(error);
    throw new FolderAttachError(mapped.message, mapped.code);
  }
  assertAllowedRoot(real);
  return real;
}

function assertReadableDirectory(dir: string): void {
  let stats;
  try {
    stats = lstatSync(dir);
    if (stats.isSymbolicLink()) {
      stats = lstatSync(realpathSync(dir));
    }
  } catch (error) {
    const mapped = describeFolderFsError(error);
    throw new FolderAttachError(mapped.message, mapped.code);
  }
  if (!stats.isDirectory()) {
    throw new FolderAttachError(FOLDER_ERROR.notDir, "notDir");
  }
  try {
    accessSync(dir, constants.R_OK);
  } catch (error) {
    const mapped = describeFolderFsError(error, FOLDER_ERROR.permission);
    throw new FolderAttachError(mapped.message, mapped.code === "io" ? "permission" : mapped.code);
  }
}

export class LocalFolderRegistry {
  constructor(private readonly file: string) {}

  list(): string[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as ConnectorStoreData;
      return Array.isArray(data.localFolders) ? unique(data.localFolders.filter((item) => typeof item === "string")) : [];
    } catch {
      return [];
    }
  }

  inspect(): LocalFolderView[] {
    return this.list().map((item) => inspectStoredFolder(item));
  }

  add(folder: string): string[] {
    const resolved = normalizeFolderInput(folder);
    assertAllowedRoot(resolved);
    const real = resolveExistingFolder(resolved);
    assertAllowedRoot(real);
    const next = unique([...this.list(), real]);
    this.save(next);
    return next;
  }

  remove(folder: string): string[] {
    const raw = folder.trim();
    if (!raw) {
      throw new FolderAttachError(FOLDER_ERROR.empty, "empty");
    }
    const current = this.list();
    const matches = new Set<string>();
    let normalized: string | undefined;
    try {
      normalized = normalizeFolderInput(raw);
      matches.add(normalized);
    } catch (error) {
      if (!(error instanceof FolderAttachError) || error.code === "empty") throw error;
    }
    try {
      if (normalized) matches.add(realpathSync(normalized));
    } catch {
      // 目录已经不在了，仍允许按已保存的路径移除。
    }
    const next = current.filter((item) => {
      if (item === raw || matches.has(item)) return false;
      try {
        return !matches.has(path.resolve(item));
      } catch {
        return true;
      }
    });
    this.save(next);
    return next;
  }

  listing(folder: string): LocalFolderListing {
    const raw = folder.trim();
    if (!raw) {
      throw new FolderAttachError(FOLDER_ERROR.empty, "empty");
    }
    const stored = this.matchStored(raw);
    if (!stored) {
      throw new FolderAttachError(FOLDER_ERROR.notAttached, "io");
    }
    const view = inspectStoredFolder(stored);
    if (view.status === "error") {
      return { path: stored, status: "error", error: view.error, entries: [] };
    }
    return listTopLevel(stored);
  }

  private matchStored(folder: string): string | undefined {
    const current = this.list();
    if (current.includes(folder)) return folder;
    let normalized: string | undefined;
    try {
      normalized = normalizeFolderInput(folder);
    } catch {
      return current.find((item) => item === folder.trim());
    }
    if (current.includes(normalized)) return normalized;
    let real: string | undefined;
    try {
      real = realpathSync(normalized);
    } catch {
      real = undefined;
    }
    return current.find((item) => item === normalized || (real && item === real));
  }

  private save(localFolders: string[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ localFolders }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export function inspectStoredFolder(stored: string): LocalFolderView {
  try {
    if (isDisallowedRoot(path.resolve(stored))) {
      return { path: stored, status: "error", error: FOLDER_ERROR.tooBroad };
    }
    const real = resolveExistingFolder(stored);
    if (isDisallowedRoot(real)) {
      return { path: stored, status: "error", error: FOLDER_ERROR.tooBroad };
    }
    return { path: stored, status: "connected" };
  } catch (error) {
    if (error instanceof FolderAttachError && error.code === "home") {
      return { path: stored, status: "error", error: FOLDER_ERROR.tooBroad };
    }
    const mapped = describeFolderFsError(error);
    return { path: stored, status: "error", error: mapped.message };
  }
}

export function listTopLevel(root: string): LocalFolderListing {
  const view = inspectStoredFolder(root);
  if (view.status === "error") {
    return { path: root, status: "error", error: view.error, entries: [] };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    const mapped = describeFolderFsError(error);
    return { path: root, status: "error", error: mapped.message, entries: [] };
  }

  let dirents;
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    const mapped = describeFolderFsError(error);
    return { path: root, status: "error", error: mapped.message, entries: [] };
  }

  const entries: LocalFolderEntry[] = [];
  const sorted = [...dirents].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  let truncated = false;
  for (const dirent of sorted) {
    if (dirent.name === "." || dirent.name === "..") continue;
    if (entries.length >= TOP_LEVEL_LIST_LIMIT) {
      truncated = true;
      break;
    }
    entries.push(describeTopLevelEntry(root, realRoot, dirent.name, dirent));
  }
  return { path: root, status: "connected", entries, truncated: truncated || undefined };
}

function describeTopLevelEntry(
  root: string,
  realRoot: string,
  name: string,
  dirent: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean },
): LocalFolderEntry {
  const full = path.join(root, name);
  if (dirent.isSymbolicLink() || isSymlink(full)) {
    return describeSymlinkEntry(full, realRoot, name);
  }
  if (dirent.isDirectory()) return { name, kind: "directory" };
  if (dirent.isFile()) return { name, kind: "file" };
  return { name, kind: "other" };
}

function isSymlink(full: string): boolean {
  try {
    return lstatSync(full).isSymbolicLink();
  } catch {
    return false;
  }
}

function describeSymlinkEntry(full: string, realRoot: string, name: string): LocalFolderEntry {
  try {
    const real = realpathSync(full);
    if (!isPathInsideRoot(realRoot, real)) {
      return { name, kind: "symlink", outside: true };
    }
    return { name, kind: "symlink" };
  } catch {
    // 悬空或无法解析的链接：当作外部目标，避免顺着它走出去。
    return { name, kind: "symlink", outside: true };
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
