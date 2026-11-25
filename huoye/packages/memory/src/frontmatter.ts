import matter from "gray-matter";
import { stringify as stringifyYaml } from "yaml";
import { formatIso, type MemoryKind } from "@huoye/schema";

export interface ParsedMemory {
  frontmatter: Record<string, unknown>;
  body: string;
  raw: string;
}

export function parseFrontmatter(raw: string): ParsedMemory {
  const parsed = matter(raw);
  const frontmatter = restoreTimestampStrings((parsed.data ?? {}) as Record<string, unknown>, raw);
  return { frontmatter, body: parsed.content.replace(/^\n/, ""), raw };
}

export function stringifyFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(serializeFrontmatter(frontmatter), { lineWidth: 0 }).trimEnd();
  const trimmedBody = body.replace(/^\n+/, "");
  return `---\n${yaml}\n---\n\n${trimmedBody}`.replace(/\n*$/, "\n");
}

/** 列表和编辑器只用正文，不要把 YAML 头信息露出去。 */
export function visibleMemoryBody(raw: string): string {
  return parseFrontmatter(raw ?? "").body.replace(/\s+$/, "\n").replace(/^\n+/, "");
}

const PROVENANCE_LINE = /^\s*[-*]\s*出处[：:].+$/;

export function isProvenanceLine(line: string): boolean {
  return PROVENANCE_LINE.test(line);
}

export function provenanceLines(text: string): string[] {
  return (text ?? "").split("\n").filter((line) => isProvenanceLine(line));
}

/** 给人看的正文：去掉机器出处行，保留在文件里的那些不在这里出现。 */
export function stripProvenanceLines(text: string): string {
  const stripped = (text ?? "")
    .split("\n")
    .filter((line) => !isProvenanceLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "\n");
  return stripped;
}

export function humanMemoryBody(raw: string): string {
  return stripProvenanceLines(visibleMemoryBody(raw));
}

/** 保存编辑后的正文时，把文件里已有的出处行补回去。 */
export function bodyWithProvenance(incomingBody: string, existingRaw: string): string {
  const cleaned = stripProvenanceLines(parseFrontmatter(incomingBody ?? "").body);
  const preserved = provenanceLines(visibleMemoryBody(existingRaw));
  const trimmed = cleaned.replace(/\s+$/, "");
  if (preserved.length === 0) return trimmed ? `${trimmed}\n` : "";
  if (!trimmed) return `${preserved.join("\n")}\n`;
  return `${trimmed}\n\n${preserved.join("\n")}\n`;
}

function serializeFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    out[key] = value instanceof Date && !Number.isNaN(value.getTime()) ? formatIso(value) : value;
  }
  return out;
}

function restoreTimestampStrings(frontmatter: Record<string, unknown>, raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...frontmatter };
  for (const [key, value] of Object.entries(out)) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) continue;
    const match = raw.match(new RegExp(`(?:^|\\n)${escapeRegExp(key)}:\\s*([^\\n]+)`));
    const scalar = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    out[key] = scalar || formatIso(value);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function inferKind(relativePath: string, fallback?: unknown): MemoryKind {
  if (fallback === "about_you" || fallback === "diary" || fallback === "upload" || fallback === "system_summary" || fallback === "other") {
    return fallback;
  }
  const p = relativePath.replace(/\\/g, "/");
  if (p === "ABOUT.md" || p.startsWith("briefs/")) return "system_summary";
  if (p.startsWith("about-you/")) return "about_you";
  if (p.startsWith("diaries/")) return "diary";
  if (p.startsWith("uploads/")) return "upload";
  if (p.startsWith("health/") || p.startsWith("recordings/")) return "other";
  return "other";
}

export function inferTitle(relativePath: string, frontmatter: Record<string, unknown>, body: string): string {
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) return frontmatter.title.trim();
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  const base = relativePath.split("/").pop() ?? relativePath;
  return base.replace(/\.md$/i, "");
}

export function snippetOf(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const head = Math.floor((max - 1) * 0.65);
  const tail = max - 1 - head;
  return `${flat.slice(0, head)}…${flat.slice(-tail)}`;
}

export function isBodyEmpty(body: string): boolean {
  const stripped = body
    .replace(/^#.+$/gm, "")
    .replace(/[-*]\s+[^:\n]+：\s*$/gm, "")
    .replace(/[-*]\s+[^:\n]+:\s*$/gm, "")
    .trim();
  return stripped.length === 0;
}
