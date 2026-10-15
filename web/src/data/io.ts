import { zip, unzip } from 'fflate'
import { db } from '../db/db'

/**
 * 完整数据导出为一个 .zip：
 *   manifest.json      —— 版本 + 元信息
 *   tables/<name>.json —— 每张表的 JSON 数组（不含 audioChunks 的 blob 字段）
 *   audio/<meeting_id>/<seq>.<ext> —— 每片音频二进制
 *
 * 打包/解包全部异步且支持进度回调。
 */

const SCHEMA = 'shibei-export'
const VERSION = 2 // bump 2 = zip + audio

interface Manifest {
  schema: string
  version: number
  exported_at: string
  table_counts: Record<string, number>
}

const TABLE_NAMES = [
  'meetings', 'transcripts', 'notes', 'summaries', 'templates',
  'todos', 'tags', 'tagBindings', 'chatMessages', 'scribbles', 'kv', 'queueJobs',
] as const

type TableName = (typeof TABLE_NAMES)[number]

/** 序列化 audioChunks → manifest + 二进制音频字典；非 chunk 表直接 toArray */
async function gatherData(): Promise<{
  manifest: Manifest
  tables: Record<TableName, unknown[]>
  audioFiles: Record<string, Uint8Array> // path → bytes
}> {
  const tables = {} as Record<TableName, unknown[]>
  for (const name of TABLE_NAMES) {
    // db[name] 的类型是 Dexie.Table<unknown, string>
    const arr = await (db as any)[name].toArray()
    tables[name] = arr
  }
  const audioChunks = await db.audioChunks.orderBy('meeting_id').toArray()
  const audioFiles: Record<string, Uint8Array> = {}
  const seenExt = new Map<string, string>()
  for (const c of audioChunks) {
    if (!c.blob || c.blob.size === 0) continue
    // ext from blob.type
    const ext = c.blob.type.includes('mp4') ? 'm4a'
      : c.blob.type.includes('ogg') ? 'ogg'
      : c.blob.type.includes('wav') ? 'wav'
      : c.blob.type.includes('aac') ? 'aac'
      : 'webm'
    const path = `audio/${c.meeting_id}/${String(c.seq).padStart(4, '0')}.${ext}`
    seenExt.set(path, ext)
    audioFiles[path] = new Uint8Array(await c.blob.arrayBuffer())
  }
  const manifest: Manifest = {
    schema: SCHEMA,
    version: VERSION,
    exported_at: new Date().toISOString(),
    table_counts: {
      ...Object.fromEntries(TABLE_NAMES.map((n) => [n, tables[n].length])),
      audioChunks: audioChunks.length,
    },
  }
  return { manifest, tables, audioFiles }
}

export interface ExportProgress {
  phase: 'reading' | 'packing' | 'done'
  ratio?: number // 0-1
  message: string
}

export async function exportData(
  onProgress?: (p: ExportProgress) => void,
): Promise<{ filename: string; sizeBytes: number; manifest: Manifest }> {
  onProgress?.({ phase: 'reading', message: '读取本地数据…' })
  const { manifest, tables, audioFiles } = await gatherData()

  onProgress?.({ phase: 'packing', message: `打包 ${Object.keys(audioFiles).length} 个音频文件…` })
  const zipObj: Record<string, Uint8Array> = {
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  }
  for (const [name, rows] of Object.entries(tables)) {
    zipObj[`tables/${name}.json`] = new TextEncoder().encode(JSON.stringify(rows))
  }
  for (const [path, bytes] of Object.entries(audioFiles)) {
    zipObj[path] = bytes
  }

  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(zipObj, { level: 6 }, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })

  const blob = new Blob([zipped], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = `shibei-${stamp}.zip`
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1500)

  onProgress?.({ phase: 'done', message: `已导出 ${Object.keys(audioFiles).length} 段音频` })
  return { filename, sizeBytes: zipped.byteLength, manifest }
}

export async function importData(
  file: File,
  onProgress?: (p: ExportProgress) => void,
): Promise<{ manifest: Manifest; audioCount: number }> {
  onProgress?.({ phase: 'reading', message: '解压 .zip…' })
  const buf = new Uint8Array(await file.arrayBuffer())
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(buf, (err, data) => {
      if (err) reject(err)
      else resolve(data as Record<string, Uint8Array>)
    })
  })

  if (!entries['manifest.json']) throw new Error('缺 manifest.json')
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json'])) as Manifest
  if (manifest.schema !== SCHEMA) throw new Error(`schema 不匹配：${manifest.schema}`)
  if (manifest.version > VERSION) throw new Error(`备份版本过高（v${manifest.version}），请升级应用`)

  const tables: Record<string, unknown[]> = {}
  for (const name of TABLE_NAMES) {
    const key = `tables/${name}.json`
    if (entries[key]) {
      tables[name] = JSON.parse(new TextDecoder().decode(entries[key]))
    }
  }

  onProgress?.({ phase: 'packing', message: '写入数据库…' })

  // 先清空业务表 + audioChunks
  for (const name of TABLE_NAMES) {
    await (db as any)[name].clear()
  }
  await db.audioChunks.clear()

  // 写入顺序：依赖方先写
  for (const name of TABLE_NAMES) {
    const rows = tables[name]
    if (rows && rows.length > 0) {
      await (db as any)[name].bulkPut(rows)
    }
  }

  // 写入音频：按 path 重组成 (meeting_id, seq)
  let audioCount = 0
  const audioEntries = Object.entries(entries).filter(([k]) => k.startsWith('audio/'))
  for (const [path, bytes] of audioEntries) {
    const m = /^audio\/([^/]+)\/(\d{4}).([^.]+)$/.exec(path)
    if (!m) continue
    const [, meetingId, seqStr, ext] = m
    const mime = ext === 'm4a' ? 'audio/mp4' : ext === 'ogg' ? 'audio/ogg' : ext === 'wav' ? 'audio/wav' : 'audio/webm'
    await db.audioChunks.put({
      id: crypto.randomUUID(),
      meeting_id: meetingId,
      seq: Number(seqStr),
      blob: new Blob([bytes], { type: mime }),
      size_bytes: bytes.byteLength,
      duration_ms: 0,
      created_at: new Date().toISOString(),
    })
    audioCount++
  }

  onProgress?.({ phase: 'done', message: `已恢复 ${audioCount} 段音频` })
  return { manifest, audioCount }
}