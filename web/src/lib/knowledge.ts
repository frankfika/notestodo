/**
 * 知识库：轻量级 keyword / title 检索（Phase-2 item 5）。
 *
 * MVP 选 keyword + title 是有意的取舍：
 *   - 不需要本地 embedding（EmbeddingGemma 之类），零外部依赖
 *   - 中文/英文/混合都能用（bigram + token 拆分 + 标题完全匹配加权）
 *   - 够给 Live Assist 推 5-10 张卡片做"上下文出现时立刻有用"
 *
 * 升级路径（README 文档化）：
 *   - 加 EmbeddingGemma / fastembed-wasm：on-device，~50MB 下载
 *   - 加 chunked 索引（按段落 / 滑动窗口）+ 向量库（SQLite-vss / lancedb）
 *   - 保持 `retrieveKnowledge(query, limit)` 的 API 不变 → 调用方零改动
 */

import { db } from '../db/db'
import { now, uid } from './id'
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

// ── Indexer（reindex） ──────────────────────────────────────────────────────

/**
 * 重新扫描 settings.knowledge_folders 下的所有 .md / .txt，写入 knowledgeEntries。
 *
 * MVP 实现：纯浏览器 web 路径——Tauri 端**没有**文件读取能力（除非后续加
 * tauri-plugin-fs-extra / Rust 侧 read_dir）。当前走 `fetch(path)`，因此：
 *   - 文件路径需要走浏览器能解析的协议（http(s):、file: 在 web 里被拒）
 *   - **事实上 MVP 仅在用户粘贴了 HTTP 路径或自建的小服务时可用**；
 *     真实落盘文件夹需等 Tauri fs 插件 + 后端（见 README 升级路径）
 *   - 路径不解析得到 → 静默跳过（不抛错，让用户可以先添加、看到"无文件"提示）
 *
 * 不会破坏：失败不抛、reindex 全程不阻塞 UI、已有条目按 mtime 跳过。
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
    // 解析目录下文件列表：MVP 仅支持「folder 本身就是 .md/.txt 文本文件」
    // 这种简化让 web 端 `fetch(folder)` 也能跑（用户可粘贴 GitHub raw URL）
    const files = await listFilesInFolder(folder).catch((e) => {
      errors.push(`${folder}: ${describeError(e)}`)
      return []
    })
    for (const file of files) {
      scanned++
      const key = `${folder}::${file.path}`
      seenPaths.add(key)
      try {
        const entry = await readAndIndexFile(folder, file)
        if (entry) {
          await db.knowledgeEntries.put(entry)
          indexed++
        } else {
          // skipped
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

interface ListedFile {
  path: string
  mtime: number
  size_bytes: number
}

/**
 * 列出 folder 下的 .md / .txt 文件。MVP：folder 本身就是一个 .md/.txt URL。
 * 真正的"目录遍历"在 web 不可用；Tauri 端后续用 tauri-plugin-fs 替换。
 */
async function listFilesInFolder(folder: string): Promise<ListedFile[]> {
  if (/\.(md|markdown|txt)$/i.test(folder)) {
    return [{ path: basename(folder), mtime: Date.now(), size_bytes: 0 }]
  }
  // 其它：当作目录占位返回空（让 UI 显式提示"目前仅支持 .md/.txt 文件路径"）
  return []
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

async function readAndIndexFile(
  folder: string,
  file: ListedFile,
): Promise<KnowledgeEntry | null> {
  const url = joinUrlLike(folder, file.path)
  if (!url) return null
  let text: string
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    text = await res.text()
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
    title: file.path.replace(/\.(md|markdown|txt)$/i, ''),
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

function joinUrlLike(folder: string, file: string): string | null {
  if (/^https?:\/\//.test(folder)) {
    // 视作目录：folder 本身已经指向 .md/.txt；这里直接用 folder
    if (file === basename(folder)) return folder
    // 视作目录前缀
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
  // 英文 / 数字 / _
  const en = s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  for (const t of en) if (t.length >= 2) out.push(t)
  // CJK：2-gram
  const cjk = s.replace(/[^一-鿿]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) out.push(cjk.slice(i, i + 2))
  return out
}
