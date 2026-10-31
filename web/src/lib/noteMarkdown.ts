/**
 * body_md ⇄ ProseMirror 文档的双向转换。
 *
 * 解析：markdown-it（+ task-lists 插件）出 token 流，把带 checkbox 的
 * list_item / bullet_list 重命名为 task_item / task_list，再走
 * prosemirror-markdown 的 MarkdownParser。
 * 序列化：prosemirror-markdown 的 MarkdownSerializer，节点表按 TipTap
 * schema 的节点名（codeBlock/bulletList/…）重写。
 *
 * 覆盖面 = MarkdownView 支持的块面：h1–h3 / 段落 / 引用 / 代码围栏 /
 * 无序 / 有序 / 任务列表 / 分割线 / 行内 粗·斜·删除线·代码·链接。
 * 其余语法（表格、图片、html）按纯文本/忽略降级——与 MarkdownView 行为一致。
 */
import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import {
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
} from 'prosemirror-markdown'
import type { Node as PMNode, Schema } from 'prosemirror-model'

const md = new MarkdownIt({ html: true, linkify: false })
md.use(taskLists, { enabled: true })

// 块颜色持久化：`<!-- color:red -->` 独占一行的 html_block 是给下一块的 attr 注释。
// 这里把它从 token 流摘掉并把颜色 attr 挂到下一块的 open token 上。
// 其它 html_block 一律忽略（与 html:false 行为一致，不引入 XSS 面——HTML 从不进文档）。
md.core.ruler.push('shibei-block-color', (state) => {
  const toks = state.tokens
  const re = /^<!--\s*color:(\w+)\s*-->\s*$/
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.type !== 'html_block') continue
    const m = t.content.trim().match(re)
    if (m && toks[i + 1] && /(_open$|^(fence|code_block|hr)$)/.test(toks[i + 1].type)) toks[i + 1].attrSet('color', m[1])
    toks.splice(i, 1)
    i--
  }
  return false
})

// [[双链]] → wiki_link_open / text / wiki_link_close（Obsidian 语法；mark 见 components/editor/wikiLink.ts）
md.inline.ruler.before('link', 'wiki_link', (state, silent) => {
  const start = state.pos
  if (state.src.slice(start, start + 2) !== '[[') return false
  const end = state.src.indexOf(']]', start + 2)
  if (end < 0) return false
  if (!silent) {
    const inner = state.src.slice(start + 2, end)
    const bar = inner.indexOf('|')
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim()
    const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim()
    const open = state.push('wiki_link_open', '', 1)
    open.attrs = [['title', target]]
    const txt = state.push('text', '', 0)
    txt.content = label
    state.push('wiki_link_close', '', -1)
  }
  state.pos = end + 2
  return true
})

// markdown-it-task-lists 给带 checkbox 的 li/bullet_list 加 class；
// MarkdownParser 的 token 表按「基础类型 + _open/_close」查找 handler，
// 把类型重命名成 task_item / task_list 就能把 checkbox 项路由到 TaskItem 节点。
md.core.ruler.after('github-task-lists', 'shibei-task-tokens', (state) => {
  const toks = state.tokens
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.type === 'bullet_list_open' && String(t.attrGet('class') ?? '').includes('contains-task-list')) {
      t.type = 'task_list_open'
      let depth = 0
      for (let j = i; j < toks.length; j++) {
        if (toks[j].type === 'bullet_list_open') depth++
        else if (toks[j].type === 'bullet_list_close') {
          depth--
          if (depth === 0) { toks[j].type = 'task_list_close'; break }
        }
      }
    } else if (t.type === 'list_item_open' && String(t.attrGet('class') ?? '').includes('task-list-item')) {
      t.type = 'task_item_open'
      // 插件把 checkbox 塞成 html_inline（content 是 <input ...> 字符串），从中读 checked
      const kids = toks[i + 2]?.children
      const chkIdx = kids?.findIndex((c) => c.type === 'html_inline' && c.content.startsWith('<input')) ?? -1
      const isChk = chkIdx >= 0
      t.attrSet('checked', isChk && kids![chkIdx].content.includes('checked') ? 'true' : 'false')
      if (isChk) {
        // 摘除 checkbox token，并把后续文本的前导空白吃掉 —— 否则 round-trip 多出空格（"- [ ]  x"）
        kids!.splice(chkIdx, 1)
        const next = kids![chkIdx]
        if (next?.type === 'text') next.content = next.content.replace(/^\s+/, '')
      }
      let depth = 0
      for (let j = i; j < toks.length; j++) {
        if (toks[j].type === 'list_item_open') depth++
        else if (toks[j].type === 'list_item_close') {
          depth--
          if (depth === 0) { toks[j].type = 'task_item_close'; break }
        }
      }
    }
  }
  return false
})

const parserCache = new WeakMap<Schema, MarkdownParser>()

function parserFor(schema: Schema): MarkdownParser {
  const cached = parserCache.get(schema)
  if (cached) return cached
  const colorOf = (tok: { attrGet: (n: string) => string | null }): { color: string | null } => ({ color: tok.attrGet('color') })
  const parser = new MarkdownParser(schema, md as never, {
    paragraph: { block: 'paragraph', getAttrs: colorOf },
    // MarkdownView 只渲染 h1–h3，更深的标题降级为三级，避免丢内容
    heading: { block: 'heading', getAttrs: (tok) => ({ level: Math.min(3, Number(tok.tag.slice(1))), ...colorOf(tok) }) },
    blockquote: { block: 'blockquote', getAttrs: colorOf },
    code_block: { block: 'codeBlock', noCloseToken: true, getAttrs: colorOf },
    fence: { block: 'codeBlock', getAttrs: (tok) => ({ language: tok.info || null, ...colorOf(tok) }), noCloseToken: true },
    hr: { node: 'horizontalRule' },
    bullet_list: { block: 'bulletList', getAttrs: colorOf },
    ordered_list: { block: 'orderedList', getAttrs: (tok) => ({ start: Number(tok.attrGet('start')) || 1, ...colorOf(tok) }) },
    list_item: { block: 'listItem' },
    task_list: { block: 'taskList', getAttrs: colorOf },
    task_item: { block: 'taskItem', getAttrs: (tok) => ({ checked: tok.attrGet('checked') === 'true' }) },
    // 插件的 checkbox 是无 _open/_close 的裸 token，必须标 noCloseToken 才会注册同名 handler
    html_inline: { ignore: true, noCloseToken: true },
    hardbreak: { node: 'hardBreak' },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    code_inline: { mark: 'code', noCloseToken: true },
    link: { mark: 'link', getAttrs: (tok) => ({ href: tok.attrGet('href') ?? '' }) },
    wiki_link: { mark: 'wikiLink', getAttrs: (tok) => ({ title: tok.attrGet('title') ?? '' }) },
  })
  parserCache.set(schema, parser)
  return parser
}

export function parseBodyToDoc(schema: Schema, bodyMd: string): PMNode {
  return parserFor(schema).parse(bodyMd || '')
}

// ── 序列化 ────────────────────────────────────────────────────────

function backticksFor(node: PMNode, side: number): string {
  const ticks = /`+/g
  let m: RegExpExecArray | null
  let len = 0
  if (node.isText) while ((m = ticks.exec(node.text!))) len = Math.max(len, m[0].length)
  let result = len > 0 && side > 0 ? ' `' : '`'
  for (let i = 0; i < len; i++) result += '`'
  if (len > 0 && side < 0) result += ' '
  return result
}

function isPlainURL(mark: PMNode['marks'][number], parent: PMNode, index: number): boolean {
  if (mark.attrs.title || !/^\w+:/.test(mark.attrs.href)) return false
  const content = parent.child(index)
  if (!content.isText || content.text !== mark.attrs.href || content.marks[content.marks.length - 1] !== mark) return false
  return index === parent.childCount - 1 || !mark.isInSet(parent.child(index + 1).marks)
}

/** 所有 item 都是单段落 → tight（行间不留空行），否则 loose。块内多段落时不能 tight。 */
function isSimpleList(node: PMNode): boolean {
  let simple = true
  node.forEach((item) => {
    if (!(item.childCount === 1 && item.firstChild!.type.name === 'paragraph')) simple = false
  })
  return simple
}

/** 照抄 MarkdownSerializerState.renderList，tight 改为按结构推导（TipTap 列表无 tight attr）。 */
function renderList(state: MarkdownSerializerState, node: PMNode, delim: string, firstDelim: (i: number) => string): void {
  const tight = isSimpleList(node)
  const st = state as unknown as MarkdownSerializerState & { closed: PMNode | null; inTightList: boolean; flushClose: (size?: number) => void }
  if (st.closed && st.closed.type === node.type) st.flushClose(3)
  else if (st.inTightList) st.flushClose(1)
  const prevTight = st.inTightList
  st.inTightList = tight
  node.forEach((child, _, i) => {
    if (i && tight) st.flushClose(1)
    st.wrapBlock(delim, firstDelim(i), node, () => st.render(child, node, i))
  })
  st.inTightList = prevTight
}

/** 带 color attr 的块前面写一行 `<!-- color:x -->`（解析端认这个语法，Obsidian 里不可见） */
function writeColor(state: MarkdownSerializerState, node: PMNode): void {
  if (node.attrs.color) state.write(`<!-- color:${String(node.attrs.color)} -->\n`)
}

const serializer = new MarkdownSerializer(
  {
    paragraph(state, node) {
      writeColor(state, node)
      state.renderInline(node)
      state.closeBlock(node)
    },
    heading(state, node) {
      writeColor(state, node)
      state.write(state.repeat('#', node.attrs.level) + ' ')
      state.renderInline(node, false)
      state.closeBlock(node)
    },
    blockquote(state, node) {
      writeColor(state, node)
      state.wrapBlock('> ', null, node, () => state.renderContent(node))
    },
    codeBlock(state, node) {
      writeColor(state, node)
      const backticks = node.textContent.match(/`{3,}/gm)
      const fence = backticks ? backticks.sort().slice(-1)[0] + '`' : '```'
      state.write(fence + (node.attrs.language || '') + '\n')
      state.text(node.textContent, false)
      state.write('\n' + fence)
      state.closeBlock(node)
    },
    horizontalRule(state, node) {
      state.write('---')
      state.closeBlock(node)
    },
    hardBreak(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i++) {
        if (parent.child(i).type !== node.type) {
          state.write('\\\n')
          return
        }
      }
    },
    text(state, node) {
      state.text(node.text!, !(state as unknown as { inAutolink?: boolean }).inAutolink)
    },
    bulletList(state, node) {
      writeColor(state, node)
      renderList(state, node, '  ', () => '- ')
    },
    orderedList(state, node) {
      writeColor(state, node)
      const start: number = node.attrs.start ?? 1
      const maxW = String(start + node.childCount - 1).length
      const space = state.repeat(' ', maxW + 2)
      renderList(state, node, space, (i) => {
        const nStr = String(start + i)
        return state.repeat(' ', maxW - nStr.length) + nStr + '. '
      })
    },
    listItem(state, node) {
      state.renderContent(node)
    },
    taskList(state, node) {
      writeColor(state, node)
      renderList(state, node, '  ', () => '- ')
    },
    taskItem(state, node) {
      state.write(node.attrs.checked ? '[x] ' : '[ ] ')
      state.renderContent(node)
    },
  },
  {
    bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
    italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
    strike: { open: '~~', close: '~~', mixable: true },
    code: {
      open: (_s, _m, parent, index) => backticksFor(parent.child(index), -1),
      close: (_s, _m, parent, index) => backticksFor(parent.child(index - 1), 1),
      escape: false,
    },
    link: {
      open(state, mark, parent, index) {
        const st = state as MarkdownSerializerState & { inAutolink?: boolean }
        st.inAutolink = isPlainURL(mark, parent, index)
        return st.inAutolink ? '<' : '['
      },
      close(state, mark) {
        const st = state as MarkdownSerializerState & { inAutolink?: boolean }
        const { inAutolink } = st
        st.inAutolink = undefined
        return inAutolink
          ? '>'
          : '](' + String(mark.attrs.href).replace(/[()"]/g, '\\$&') + ')'
      },
      mixable: true,
    },
    wikiLink: {
      open: (_state, mark) => `[[${String(mark.attrs.title)}|`,
      close: ']]',
      mixable: true,
    },
  },
  { hardBreakNodeName: 'hardBreak' },
)

export function serializeDocToMd(doc: PMNode): string {
  // 别名与目标相同的双链归并回 [[目标]]（mark 的 open/close 拿不到正文，只能后处理）
  return serializer.serialize(doc).replace(/\[\[([^\][|]+)\|([^\]]+)\]\]/g, (m, t, l) => (t === l ? `[[${t}]]` : m))
}
