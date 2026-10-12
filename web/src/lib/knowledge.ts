/**
 * 知识库：轻量级 keyword / title 检索（Phase-2 item 5）。
 *
 * MVP 选 keyword + title 是有意的取舍：
 *   - 不需要本地 embedding（EmbeddingGemma 之类），零外部依赖
 *   - 中文/英文/混合都能用（bigram + token 拆分 + 标题完全匹配加权）
 *   - 够给 Live Assist 推 5-10 张卡片做"上下文出现时立刻有用"
 *
 * Phase-3: 在 Tauri desktop 端，真正读本地文件夹（递归走 .md / .txt）—— 用
 * tauri-plugin-fs 的 plugin command；web 仍只接受 HTTP(S) URL（浏览器无法
 * 任意读本地盘）。folders 混合（Tauri 本地路径 + http URL）按各自路径走。
 *
 * 升级路径（README 文档化）：
 *   - 加 EmbeddingGemma / fastembed-wasm：on-device，~50MB 下载
 *   - 加 chunked 索引（按段落 / 滑动窗口）+ 向量库（SQLite-vss / lancedb）
 *   - 加 PDF 文本提取（pdfjs-dist / unpdf / Tauri Rust crate 三选一）
 *   - 保持 `retrieveKnowledge(query, limit)` 的 API 不变 → 调用方零改动
 */

import { db } from '../db/db'
import { now, uid } from './id'
import { isTauri } from './tauri'
import { invoke } from './tauriInvoke'
import type { KnowledgeEntry, PinnedAssistCard } from '../types'

// ── 常量 / 限制 ────────────────────────────────────────────────────────────

/** 单文件 snippet 取前 N 字符（卡片展示足够；不要 fullText 长度上限撞到 IndexedDB） */
const SNIPPET_CHARS = 400
/** fullText 上限：超大文件截断（防内存爆 + 检索噪声） */
const FULLTEXT_CAP = 8_000
/** 检索返回卡片上限 */
const RETRIEVE_LIMIT_DEFAULT = 8
/** title 完全命中加权（bigram 相似性之上额外加的常量） */
const TITLE_BOOST = 0.4
/** Tauri read_dir 一次性最大返回（够用；防止超宽目录炸内存） */
const MAX_LOCAL_FILES = 2_000
/** Reindex 时支持的文件后缀（keyword 检索：纯文本；Phase-3 新增 PDF） */
const TEXT_EXTS = ['.md', '.markdown', '.txt']
const PDF_EXTS = ['.pdf']
const ALL_EXTS = [...TEXT_EXTS, ...PDF_EXTS]

// ── Indexer（reindex） ──────────────────────────────────────────────────────

interface ListedFile {
  /** 相对路径（如 `notes/idea.md`），与 folder 拼接出绝对路径 / URL */
  path: string
  mtime: number
  size_bytes: number
  /** 'md' | 'pdf' — Phase-3: PDF takes a different read path (binary + extract). */
  kind: 'md' | 'pdf'
}

/**
 * 重新扫描 settings.knowledge_folders 下的所有 .md / .txt，写入 knowledgeEntries。
 *
 * Path 分发（按纯函数判定，避免 Tauri / web 二选一时回退）：
 *   - Tauri && 非 http(s)://   → 走 tauri-plugin-fs，递归 walk 本地目录
 *   - web / http(s)://         → 沿用旧 fetch 路径
 *
 * 不会破坏：失败不抛、reindex 全程不阻塞 UI、已有条目按 (folder, path) 跳过清理。
 */
export async function reindexKnowledge(folders: string[]): Promise<{
  scanned: number
  indexed: number
  skipped: number
  errors: string[]
}> {
  const errors: string[] = []
  let scanned = 0
  let indexed = 0
  const seenPaths = new Set<string>()

  for (const folder of folders) {
    const useLocal = isTauri() && !/^https?:\/\//i.test(folder)
    let files: ListedFile[]
    try {
      files = useLocal
        ? await listLocalFiles(folder)
        : await listRemoteFiles(folder)
    } catch (e) {
      errors.push(`${folder}: ${describeError(e)}`)
      continue
    }
    if (files.length > MAX_LOCAL_FILES) {
      files = files.slice(0, MAX_LOCAL_FILES)
      errors.push(`${folder}: 文件超过 ${MAX_LOCAL_FILES} 个上限，已截断（避免阻塞 UI）`)
    }

    for (const file of files) {
      scanned++
      const key = `${folder}::${file.path}`
      seenPaths.add(key)
      try {
        const entry = await readAndIndexFile(folder, file, useLocal)
        if (entry) {
          await db.knowledgeEntries.put(entry)
          indexed++
        }
      } catch (e) {
        errors.push(`${file.path}: ${describeError(e)}`)
      }
    }
  }

  // 清理：移除已不在 folders 里的旧条目
  if (folders.length > 0) {
    const all = await db.knowledgeEntries.toArray()
    const stale = all.filter((e) => !seenPaths.has(`${e.folder}::${e.path}`))
    if (stale.length > 0) {
      await db.knowledgeEntries.bulkDelete(stale.map((e) => e.id))
    }
  }

  return { scanned, indexed, skipped: scanned - indexed, errors }
}

// ── Listers ────────────────────────────────────────────────────────────────

/**
 * Tauri 本地目录递归走 .md / .txt / .pdf（Phase-3 新增）。
 *
 * 用 plugin:fs|read_dir 的 `recursive: true` 拿扁平的 FileInfo 列表 —— 比
 * 自己维护队列省一次 IPC、也避免权限链扩大的栈风险。过滤文件名后缀。
 *
 * 对单文件路径（folder 本身是 .md/.txt/.pdf 文件），直接返回该文件。
 */
async function listLocalFiles(folder: string): Promise<ListedFile[]> {
  const directKind = kindOfFile(folder)
  if (directKind) {
    // folder 本身是一个本地文件 —— tauri-plugin-fs 无法 list
    // 其父目录（除非作用域未授权），索性当作单一文件处理。
    return [{ path: basename(folder), mtime: Date.now(), size_bytes: 0, kind: directKind }]
  }
  type FileInfo = {
    path: string  // 完整路径
    name?: string
    isDirectory: boolean
    isFile: boolean
    isSymlink: boolean
  }
  let entries: FileInfo[]
  try {
    entries = await invoke<FileInfo[]>('plugin:fs|read_dir', {
      path: folder,
      options: { recursive: true },
    })
  } catch (e) {
    // 极少见：folder 不存在 / 权限拒 / 没注册 fs 插件
    throw new Error(`读取目录失败：${describeError(e)}`)
  }
  const out: ListedFile[] = []
  for (const entry of entries) {
    if (!entry.isFile || entry.isSymlink) continue
    const lower = entry.path.toLowerCase()
    const kind = kindOfFile(lower)
    if (!kind) continue
    // 相对路径：folder 是根，取相对部分供 UI 展示
    const rel = relPath(entry.path, folder)
    out.push({ path: rel, mtime: Date.now(), size_bytes: 0, kind })
  }
  return out
}

/**
 * Web / HTTP(S) URL 兼容路径（Phase-2 旧行为 + 直链 .md/.txt/.pdf）。
 * 浏览器里 fetch 文件夹不可行；folder 本身若就是一个可索引文件 URL 才有效。
 */
async function listRemoteFiles(folder: string): Promise<ListedFile[]> {
  const kind = kindOfFile(folder)
  if (kind) {
    return [{ path: basename(folder), mtime: Date.now(), size_bytes: 0, kind }]
  }
  return []
}

// ── Reader ─────────────────────────────────────────────────────────────────

async function readAndIndexFile(
  folder: string,
  file: ListedFile,
  useLocal: boolean,
): Promise<KnowledgeEntry | null> {
  let text: string
  try {
    if (file.kind === 'pdf') {
      text = await readPdfBody(folder, file, useLocal)
    } else if (useLocal) {
      // plugin:fs|read_text_file — 以 folder 为基准拼绝对路径
      const abs = joinPath(folder, file.path)
      text = await invoke<string>('plugin:fs|read_text_file', { path: abs })
    } else {
      const url = joinUrlLike(folder, file.path)
      if (!url) return null
      const res = await fetch(url)
      if (!res.ok) return null
      text = await res.text()
    }
  } catch {
    return null
  }
  if (!text || text.trim().length === 0) return null
  const id = uid()
  const nowIso = now()
  return {
    id,
    folder,
    path: file.path,
    title: file.path.replace(/\.(md|markdown|txt|pdf)$/i, ''),
    snippet: text.slice(0, SNIPPET_CHARS).replace(/\s+/g, ' ').trim(),
    fullText: text.length > FULLTEXT_CAP ? text.slice(0, FULLTEXT_CAP) : text,
    mtime: file.mtime,
    size_bytes: text.length,
    created_at: nowIso,
    updated_at: nowIso,
    deleted_at: null,
    sync_version: 0,
  }
}

/**
 * PDF 路径：拿原始字节，调 pdfjs-dist 抽文字。
 * 抽不出来的（损坏 / 扫描件 / 加密）→ 返回空字符串，让 caller 走 "skip"。
 */
async function readPdfBody(
  folder: string,
  file: ListedFile,
  useLocal: boolean,
): Promise<string> {
  let bytes: Uint8Array | null = null
  try {
    if (useLocal) {
      const abs = joinPath(folder, file.path)
      // plugin:fs|read_file 返回 Uint8Array（base64 iframe 在 Rust 端解）
      const raw = await invoke<number[] | Uint8Array | string>('plugin:fs|read_file', { path: abs })
      bytes = normaliseBytes(raw)
    } else {
      const url = joinUrlLike(folder, file.path)
      if (!url) return ''
      const res = await fetch(url)
      if (!res.ok) return ''
      const buf = await res.arrayBuffer()
      bytes = new Uint8Array(buf)
    }
  } catch {
    return ''
  }
  if (!bytes) return ''
  try {
    const { extractPdfText } = await import('./pdf')
    return await extractPdfText(bytes)
  } catch {
    return ''
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function basename(p: string): string {
  // 支持绝对 POSIX 路径与 URL 末尾路径段
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

/** 文件后缀 → kind；非可索引文件返回 null。 */
function kindOfFile(name: string): 'md' | 'pdf' | null {
  const lower = name.toLowerCase()
  for (const ext of TEXT_EXTS) if (lower.endsWith(ext)) return 'md'
  for (const ext of PDF_EXTS) if (lower.endsWith(ext)) return 'pdf'
  return null
}

/** tauri-plugin-fs 的 read_file 历史版本返回值 shape 不一：number[] / Uint8Array / base64 string 都见过。统一成 Uint8Array。 */
function normaliseBytes(raw: number[] | Uint8Array | string): Uint8Array {
  if (raw instanceof Uint8Array) return raw
  if (typeof raw === 'string') {
    // base64 兜底（极少见，留一手）
    const bin = atob(raw)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  // number[]
  return new Uint8Array(raw)
}

function joinPath(folder: string, file: string): string {
  // 绝对文件直接返回；否则 folder + '/' + file，并清理多余斜杠
  if (file.startsWith('/')) return file
  return folder.replace(/\/+$/, '') + '/' + file.replace(/^\/+/, '')
}

function relPath(abs: string, root: string): string {
  // 入参 abs 不一定真有 root 前缀（macOS 也可能 /private/var/... 与 /var/...）
  // —— 简单做法：去掉 root 前缀（若有）
  let a = abs
  if (a.startsWith(root)) a = a.slice(root.length)
  return a.replace(/^\/+/, '') || basename(abs)
}

function joinUrlLike(folder: string, file: string): string | null {
  if (/^https?:\/\//.test(folder)) {
    if (file === basename(folder)) return folder
    return folder.replace(/\/+$/, '') + '/' + file
  }
  if (/^https?:\/\//.test(file)) return file
  return null
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── Retrieval（关键词 + 标题匹配） ─────────────────────────────────────────

/**
 * 关键词检索。返回 relevance 降序的卡片列表。
 * 打分：bigram Jaccard（query vs snippet+title）+ title 全词命中加权。
 */
export function retrieveKnowledge(
  query: string,
  entries: KnowledgeEntry[],
  limit = RETRIEVE_LIMIT_DEFAULT,
): KnowledgeEntry[] {
  const q = query.trim()
  if (!q) return []
  const qBigrams = bigrams(q)
  const qTokens = new Set(tokens(q))
  if (qBigrams.size === 0 && qTokens.size === 0) return []

  const scored: { e: KnowledgeEntry; s: number }[] = []
  for (const e of entries) {
    if (e.deleted_at) continue
    const titleB = bigrams(e.title)
    const fullB = bigrams((e.title + ' ' + e.snippet + ' ' + e.fullText.slice(0, 1500)).toLowerCase())

    // token-level
    let tokenHit = 0
    const eTokens = new Set(tokens(e.title + ' ' + e.snippet.slice(0, 200)))
    for (const t of qTokens) if (eTokens.has(t)) tokenHit++

    // bigram Jaccard
    let inter = 0
    for (const g of qBigrams) if (fullB.has(g)) inter++
    const denom = qBigrams.size + fullB.size - inter
    let score = denom > 0 ? inter / denom : 0

    // title 完全包含 query：强加权
    if (e.title.toLowerCase().includes(q.toLowerCase())) {
      score += TITLE_BOOST
    }
    // title bigram 重合
    if (titleB.size > 0) {
      let tInter = 0
      for (const g of qBigrams) if (titleB.has(g)) tInter++
      const tDenom = qBigrams.size + titleB.size - tInter
      if (tDenom > 0) score += (tInter / tDenom) * 0.5
    }
    // token 命中加权
    if (qTokens.size > 0) score += (tokenHit / qTokens.size) * 0.3

    if (score > 0.05) scored.push({ e, s: score })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map((x) => x.e)
}

// ── Pinned assist 卡片（持久化在会议下） ──────────────────────────────────

/** 把当前 retrieve 结果中需要 pin 的卡片持久化。 */
export async function pinAssistCard(
  meetingId: string,
  entry: KnowledgeEntry,
): Promise<PinnedAssistCard> {
  const existing = await db.pinnedAssistCards
    .where('meeting_id').equals(meetingId)
    .and((c) => c.source_entry_id === entry.id).first()
  if (existing) return existing
  const nowIso = now()
  const card: PinnedAssistCard = {
    id: uid(),
    meeting_id: meetingId,
    source_entry_id: entry.id,
    title: entry.title,
    snippet: entry.snippet,
    path: `${entry.folder}/${entry.path}`,
    created_at: nowIso,
    updated_at: nowIso,
    deleted_at: null,
    sync_version: 0,
  }
  await db.pinnedAssistCards.put(card)
  return card
}

export async function unpinAssistCard(id: string): Promise<void> {
  await db.pinnedAssistCards.delete(id)
}

export async function listPinnedCards(meetingId: string): Promise<PinnedAssistCard[]> {
  return db.pinnedAssistCards
    .where('meeting_id').equals(meetingId)
    .filter((c) => c.deleted_at === null)
    .sortBy('created_at')
}

// ── 工具（与 lib/okr 里的 bigrams 同源；不直接 import 以避免耦合） ──────

function bigrams(s: string): Set<string> {
  const x = s.toLowerCase().replace(/\s+/g, '')
  const out = new Set<string>()
  for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2))
  if (x.length === 1) out.add(x)
  return out
}

/** token 化：中英文混排；CJK 字符 2-gram 拆分，英文按 \w+ 切 */
function tokens(s: string): string[] {
  const out: string[] = []
  const en = s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  for (const t of en) if (t.length >= 2) out.push(t)
  const cjk = s.replace(/[^一-鿿]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) out.push(cjk.slice(i, i + 2))
  return out
}
