import path from "node:path";
import { MemoryPathError } from "./errors";

export function normalizeRelative(relativePath: string): string {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new MemoryPathError("路径无效");
  }
  const posix = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!posix) throw new MemoryPathError("路径无效");
  if (posix.startsWith("/") || posix.startsWith("~") || /^[a-zA-Z]:/.test(posix)) {
    throw new MemoryPathError("禁止绝对路径");
  }
  const parts = posix.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "" || part === "~")) {
    throw new MemoryPathError("禁止路径穿越");
  }
  return parts.join("/");
}

export function resolveSafe(root: string, relativePath: string): { absolute: string; relative: string } {
  const relative = normalizeRelative(relativePath);
  const rootAbs = path.resolve(root);
  const absolute = path.resolve(rootAbs, ...relative.split("/"));
  const relToRoot = path.relative(rootAbs, absolute);
  if (!relToRoot || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    throw new MemoryPathError("禁止路径穿越");
  }
  return { absolute, relative };
}
