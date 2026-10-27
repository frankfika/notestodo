import { zipSync, strToU8 } from 'fflate'
import { db } from '../db/db'
import type { Note, Todo } from '../types'

// 测试在页面上下文里解包 zip 用（浏览器里裸 import 'fflate' 解析不到）
export { unzipSync, strFromU8 } from 'fflate'

/**
 * Obsidian 式「数据在你手里」导出：全部笔记 → 纯 Markdown 文件（YAML frontmatter 保留
 * id / 时间戳，导回或留作档案都不丢信息），全部任务 → 一棵嵌套 GFM 任务列表。
 * 产物是一个 zip，随便哪个文件夹都能当 vault 打开。
 */

function sanitizeFilename(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
  return (cleaned || '未命名').slice(0, 80)
}

function noteToMd(n: Note): string {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const frontmatter = [
    '---',
    `shibei_id: ${n.id}`,
    `title: "${esc(n.title)}"`,
    `created_at: ${n.created_at}`,
    `updated_at: ${n.updated_at}`,
    '---',
    '',
  ].join('\n')
  return frontmatter + (n.body_md ?? '') + '\n'
}

/** 任务 → 嵌套 GFM 任务列表（按树序；孤儿挂在末尾） */
export function todosToMarkdown(todos: Todo[]): string {
  const live = todos.filter((t) => t.deleted_at === null)
  const byId = new Map(live.map((t) => [t.id, t]))
  const kids = new Map<string | null, Todo[]>()
  for (const t of live) {
    const key = t.parent_id && byId.has(t.parent_id) ? t.parent_id : null
    const list = kids.get(key) ?? []
    list.push(t)
    kids.set(key, list)
  }
  const lines: string[] = ['# 拾贝任务', '']
  const walk = (parent: string | null, depth: number): void => {
    const list = (kids.get(parent) ?? []).sort((a, b) => a.sort_order - b.sort_order)
    for (const t of list) {
      const check = t.status === 'done' ? 'x' : ' '
      const due = t.due_date ? ` 📅 ${t.due_date}` : ''
      lines.push(`${'  '.repeat(depth)}- [${check}] ${t.title}${due}`)
      walk(t.id, depth + 1)
    }
  }
  walk(null, 0)
  return lines.join('\n') + '\n'
}

export interface MarkdownZipResult {
  filename: string
  sizeBytes: number
  fileCount: number
}

export function buildMarkdownZip(notes: Note[], todos: Todo[]): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const used = new Set<string>()
  for (const n of notes) {
    let name = `${sanitizeFilename(n.title)}.md`
    if (used.has(name)) name = `${sanitizeFilename(n.title)}-${n.id.slice(0, 6)}.md`
    used.add(name)
    files[name] = strToU8(noteToMd(n))
  }
  files['拾贝任务.md'] = strToU8(todosToMarkdown(todos))
  return zipSync(files, { level: 6 })
}

/** 拉库 → 打包 → 触发下载。返回打包结果（测试里用 buildMarkdownZip 直验内容）。 */
export async function exportMarkdownVault(): Promise<MarkdownZipResult> {
  const [notes, todos] = await Promise.all([db.notes.toArray(), db.todos.toArray()])
  const zipped = buildMarkdownZip(notes, todos)
  const blob = new Blob([zipped], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `shibei-vault-${stamp}.zip`
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  return { filename, sizeBytes: zipped.byteLength, fileCount: notes.length + 1 }
}
