/**
 * PDF text extraction (Phase-3 Gap 3).
 *
 * Lazy-loaded only when a .pdf is encountered by lib/knowledge.ts so that
 * pdfjs (~1MB worker + core) does not bloat the main web bundle for users
 * who never touch a PDF. Vite code-splits `import('./pdf')` into its own chunk.
 *
 * Behaviour:
 *   - cap pages at MAX_PAGES (skip the 30-page legal-bill PDF forever looping)
 *   - skip scanned / image-only PDFs gracefully — empty text → caller skips
 *   - never throw: caller treats '' as "not indexable, move on"
 *
 * Upgrade paths if this becomes a hot spot:
 *   - swap pdfjs-dist for a Rust-side extractor in Tauri (no JS bundle cost)
 *   - shard by page range so 200-page PDFs can stream
 */

import * as pdfjsLib from 'pdfjs-dist'
// Vite `?url` turns the worker into a URL the runtime can fetch. Without it,
// pdfjs silently fails to spin up the worker and getDocument hangs.
// import needs to be static (Vite requires literal paths for ?url queries).
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

/** Pages beyond this are skipped silently (most meeting notes / KB articles fit). */
const MAX_PAGES = 50

/** Cheap shape check; pdfjs types ship as `any`-ish unions across versions. */
interface PdfTextItem {
  str?: string
}

/**
 * Extract plain text from a PDF byte array. Returns '' on any failure or for
 * PDFs without extractable text (scanned, image-only). Caller is expected to
 * discard empty results so we never poison the knowledge index.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  if (!bytes || bytes.byteLength === 0) return ''
  let doc
  try {
    doc = await pdfjsLib.getDocument({ data: bytes }).promise
  } catch {
    return ''
  }
  const pagesToRead = Math.min(doc.numPages, MAX_PAGES)
  const out: string[] = []
  for (let i = 1; i <= pagesToRead; i++) {
    try {
      const page = await doc.getPage(i)
      const txt = await page.getTextContent()
      const parts: string[] = []
      for (const item of txt.items as PdfTextItem[]) {
        if (item?.str) parts.push(item.str)
      }
      const pageText = parts.join(' ').replace(/\s+/g, ' ').trim()
      if (pageText) out.push(pageText)
    } catch {
      // 一页坏了不影响整本 —— 跳过
      continue
    }
  }
  return out.join('\n\n')
}
