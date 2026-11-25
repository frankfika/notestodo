import { createHash } from "node:crypto";
import { statSync } from "node:fs";

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function revisionFor(absolutePath: string, content: string): string {
  let mtime = "0";
  try {
    mtime = String(statSync(absolutePath).mtimeMs);
  } catch {
    mtime = "0";
  }
  return `${mtime}:${hashContent(content)}`;
}

export function hashOfRevision(revision: string): string {
  const idx = revision.indexOf(":");
  return idx >= 0 ? revision.slice(idx + 1) : revision;
}
