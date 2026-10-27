import { InputRule, Mark, mergeAttributes } from '@tiptap/core'

/**
 * 双链（Obsidian 风格 [[标题]] / [[标题|别名]]）：
 * markdown-it 解析成 mark（noteMarkdown.ts 里的 wiki_link_open/close token），
 * 序列化回 [[标题|别名]]（相同时归并回 [[标题]]，见 serializeDocToMd 的后处理）；
 * 输入时打 [[ 触发 input rule 就地转换；点击由 NoteEditor 的 handleClick 接管跳转。
 */
export const WikiLink = Mark.create({
  name: 'wikiLink',
  inclusive: false,
  keepOnSplit: false,

  addAttributes() {
    return { title: { default: '' } }
  },

  parseHTML() {
    return [{ tag: 'span[data-wiki]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-wiki': '', class: 'wiki-link' }), 0]
  },

  addInputRules() {
    const make = (alias: boolean): InputRule['handler'] => ({ state, range, match }) => {
      const title = match[1].trim()
      const label = alias ? match[2].trim() : title
      const tr = state.tr
      tr.insertText(label, range.from, range.to)
      tr.addMark(range.from, range.from + label.length, state.schema.marks.wikiLink.create({ title }))
      tr.removeStoredMark(state.schema.marks.wikiLink)
    }
    return [
      new InputRule({ find: /\[\[([^\][|]+)\|([^\]]+)\]\]$/, handler: make(true) }),
      new InputRule({ find: /\[\[([^\][|]+)\]\]$/, handler: make(false) }),
    ]
  },
})
