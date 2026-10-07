import { useMemo } from 'react'

/**
 * 超简版 markdown 视图：标题 / 列表 / 粗体 / 行内代码 / 代码围栏 / 段落。
 * 不引入 markdown 库（SHARED_SPEC §5.3 1.纪要）。所有渲染走 React 文本节点，
 * 不使用 dangerouslySetInnerHTML，所以用户输入天然安全。
 */

interface Block {
  kind: 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'ul-tasks' | 'quote' | 'code' | 'p' | 'hr'
  items?: string[]
  /**
   * 仅 ul-tasks 用：`true` 已勾选，`false` 未勾选；与 items 一一对应。
   */
  checked?: boolean[]
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.trimEnd()
    if (line.trim() === '') { i++; continue }
    if (/^```/.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // skip closing ```
      blocks.push({ kind: 'code', items: buf })
      continue
    }
    if (/^---+$/.test(line.trim())) { blocks.push({ kind: 'hr' }); i++; continue }
    const h = /^(#{1,3})\s+(.+)$/.exec(line)
    if (h) {
      const level = h[1].length as 1 | 2 | 3
      blocks.push({ kind: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', items: [h[2]] })
      i++
      continue
    }
    // 引用块（可多行）
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ kind: 'quote', items: [buf.join(' / ')] })
      continue
    }
    // GFM 任务列表（[-*][ \t ]+[[ xX]][ \t ]+...）
    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(raw)) {
      const items: string[] = []
      const checked: boolean[] = []
      while (i < lines.length && /^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const m = /^\s*[-*]\s+\[(.)\]\s+(.+)$/.exec(lines[i])
        if (m) {
          checked.push(m[1].toLowerCase() === 'x')
          items.push(m[2])
        }
        i++
      }
      blocks.push({ kind: 'ul-tasks', items, checked })
      continue
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      blocks.push({ kind: 'ul', items })
      continue
    }
    if (/^\s*\d+\.\s+/.test(raw)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push({ kind: 'ol', items })
      continue
    }
    // 段落：合并到下一个空行 / 块开始
    const buf: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      buf.push(lines[i].trimEnd())
      i++
    }
    blocks.push({ kind: 'p', items: [buf.join(' ')] })
  }
  return blocks
}

/**
 * 把单行内联语法解析成 React 节点数组。**不**拼接 HTML，**不**使用
 * dangerouslySetInnerHTML；只输出 React 元素，自然转义。
 */
import type { ReactNode } from 'react'
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  // 顺序：行内代码 → 粗体 → 斜体 → 链接
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(<code key={`${keyBase}-c-${k++}`} className="font-mono text-[0.9em] bg-bg-overlay px-1 py-0.5 rounded">{tok.slice(1, -1)}</code>)
    } else if (tok.startsWith('**')) {
      out.push(<strong key={`${keyBase}-b-${k++}`} className="font-semibold text-text-1">{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('*')) {
      out.push(<em key={`${keyBase}-i-${k++}`} className="italic">{tok.slice(1, -1)}</em>)
    } else if (tok.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      if (lm) {
        out.push(
          <a
            key={`${keyBase}-a-${k++}`}
            href={lm[2]}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent"
          >
            {lm[1]}
          </a>,
        )
      }
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export interface MarkdownViewProps {
  source: string
}

export default function MarkdownView({ source }: MarkdownViewProps): JSX.Element {
  const blocks = useMemo(() => parseBlocks(source || ''), [source])
  return (
    <div className="markdown-view text-[15px] leading-[1.75] text-text-1 space-y-3">
      {blocks.length === 0 && (
        <p className="text-text-3 text-sm italic">（空白）</p>
      )}
      {blocks.map((b, i) => {
        if (b.kind === 'h1') return <h1 key={i} className="text-2xl font-semibold text-text-1 mt-2">{inline(b.items![0], `h1-${i}`)}</h1>
        if (b.kind === 'h2') return <h2 key={i} className="text-lg font-semibold text-text-1 mt-4">{inline(b.items![0], `h2-${i}`)}</h2>
        if (b.kind === 'h3') return <h3 key={i} className="text-base font-semibold text-text-2 mt-3">{inline(b.items![0], `h3-${i}`)}</h3>
        if (b.kind === 'quote') {
          return (
            <blockquote key={i} className="border-l-2 border-accent/40 pl-3 text-text-2 my-2 italic">
              {inline(b.items![0], `q-${i}`)}
            </blockquote>
          )
        }
        if (b.kind === 'ul') {
          return (
            <ul key={i} className="list-disc list-outside pl-5 space-y-1 marker:text-text-3">
              {b.items!.map((it, j) => <li key={j}>{inline(it, `ul-${i}-${j}`)}</li>)}
            </ul>
          )
        }
        if (b.kind === 'ol') {
          return (
            <ol key={i} className="list-decimal list-outside pl-5 space-y-1 marker:text-text-3">
              {b.items!.map((it, j) => <li key={j}>{inline(it, `ol-${i}-${j}`)}</li>)}
            </ol>
          )
        }
        if (b.kind === 'ul-tasks') {
          return (
            <ul key={i} className="space-y-1 pl-0 list-none">
              {b.items!.map((it, j) => {
                const checked = b.checked![j]
                return (
                  <li key={j} className="flex items-baseline gap-2 text-[14.5px]">
                    <span
                      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                        checked ? 'bg-accent border-accent text-accent-contrast' : 'border-line-strong text-text-3'
                      }`}
                      aria-hidden
                    >{checked ? '✓' : ''}</span>
                    <span className={checked ? 'line-through text-text-3' : 'text-text-1'}>{inline(it, `ult-${i}-${j}`)}</span>
                  </li>
                )
              })}
            </ul>
          )
        }
        if (b.kind === 'code') {
          return (
            <pre key={i} className="bg-bg-overlay border border-line rounded-lg p-3 font-mono text-[12.5px] leading-relaxed overflow-x-auto">
              <code>{b.items!.join('\n')}</code>
            </pre>
          )
        }
        if (b.kind === 'hr') return <hr key={i} className="border-line my-4" />
        return <p key={i}>{inline(b.items![0], `p-${i}`)}</p>
      })}
    </div>
  )
}