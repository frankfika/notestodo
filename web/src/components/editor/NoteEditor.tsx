import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type ChainedCommands, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { Placeholder, TrailingNode } from '@tiptap/extensions'
import { Extension } from '@tiptap/core'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { NodeSelection, PluginKey } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import { parseBodyToDoc, serializeDocToMd } from '../../lib/noteMarkdown'
import { WikiLink } from './wikiLink'

export interface NoteEditorProps {
  initialMarkdown: string
  onChange: (md: string) => void
  onReady?: (editor: Editor) => void
  /** 点击 [[双链]] 时回调（参数是链接目标标题）；不传则链接不可点 */
  onWikiOpen?: (title: string) => void
}

// ── 斜杠菜单 ──────────────────────────────────────────────────────

interface SlashItem {
  id: string
  label: string
  hint: string
  keys: string
  run: (ch: ChainedCommands) => ChainedCommands
}

const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', label: '正文', hint: '普通段落', keys: 'text p zhengwen', run: (ch) => ch.setParagraph() },
  { id: 'h1', label: '一级标题', hint: '# 大标题', keys: 'h1 heading biaoti', run: (ch) => ch.toggleHeading({ level: 1 }) },
  { id: 'h2', label: '二级标题', hint: '## 小节', keys: 'h2 heading biaoti', run: (ch) => ch.toggleHeading({ level: 2 }) },
  { id: 'h3', label: '三级标题', hint: '### 子节', keys: 'h3 heading biaoti', run: (ch) => ch.toggleHeading({ level: 3 }) },
  {
    id: 'todo', label: '待办列表', hint: '可勾选的清单', keys: 'todo task checkbox daiban',
    run: (ch) => ch.insertContent({
      type: 'taskList',
      content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }],
    }),
  },
  { id: 'bullet', label: '无序列表', hint: '• 圆点列表', keys: 'bullet ul list liebiao', run: (ch) => ch.toggleBulletList() },
  { id: 'ordered', label: '有序列表', hint: '1. 编号列表', keys: 'ol number list liebiao', run: (ch) => ch.toggleOrderedList() },
  { id: 'quote', label: '引用', hint: '左侧竖线引用', keys: 'quote yinyong', run: (ch) => ch.toggleBlockquote() },
  { id: 'code', label: '代码块', hint: '等宽字体片段', keys: 'code daima', run: (ch) => ch.toggleCodeBlock() },
  { id: 'divider', label: '分割线', hint: '一条横线', keys: 'hr divider fenge', run: (ch) => ch.setHorizontalRule() },
]

function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return SLASH_ITEMS
  return SLASH_ITEMS.filter((it) => (it.label + ' ' + it.keys).toLowerCase().includes(q))
}

type SlashCtl = {
  open: (p: SuggestionProps<SlashItem>) => void
  update: (p: SuggestionProps<SlashItem>) => void
  close: () => void
  keydown: (e: SuggestionKeyDownProps) => boolean
}

// ponytail: 选中多个块的框选不做；跨块文本选择原生支持，块级拖动是单块。
// 需要多块框选时参考 BlockNote 的块选择插件，那是一个独立的 PM 插件量级。

export default function NoteEditor({ initialMarkdown, onChange, onReady, onWikiOpen }: NoteEditorProps): JSX.Element {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onWikiOpenRef = useRef(onWikiOpen)
  onWikiOpenRef.current = onWikiOpen

  const wrapRef = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<{ top: number; pos: number } | null>(null)
  const handleMirror = useRef(handle)
  handleMirror.current = handle
  const hoverBlock = useRef<{ pos: number; el: HTMLElement } | null>(null)
  const dragSrc = useRef<{ pos: number } | null>(null)
  const markedEl = useRef<HTMLElement | null>(null)

  // 斜杠菜单：controller 挂 ref，Suggestion 的 render 回调跨组件生命周期调用它
  const [slash, setSlash] = useState<{ items: SlashItem[]; index: number; rect: { left: number; top: number } | null } | null>(null)
  const slashMirror = useRef(slash)
  slashMirror.current = slash
  const slashProps = useRef<SuggestionProps<SlashItem> | null>(null)

  const slashCtl = useRef<SlashCtl | null>(null)
  if (!slashCtl.current) {
    const choose = (item: SlashItem): void => {
      const p = slashProps.current
      slashProps.current = null
      setSlash(null)
      p?.command(item)
    }
    slashCtl.current = {
      open: (p) => {
        slashProps.current = p
        const r = p.clientRect?.()
        setSlash({ items: p.items, index: 0, rect: r ? { left: r.left, top: r.top } : null })
      },
      update: (p) => {
        slashProps.current = p
        setSlash((s) => s && ({
          items: p.items,
          index: Math.min(slashMirror.current?.index ?? 0, Math.max(0, p.items.length - 1)),
          rect: p.clientRect?.() ? { left: p.clientRect()!.left, top: p.clientRect()!.top } : s.rect,
        }))
      },
      close: () => {
        slashProps.current = null
        setSlash(null)
      },
      keydown: ({ event }) => {
        const s = slashMirror.current
        if (!s || s.items.length === 0) return false
        if (event.key === 'ArrowUp') {
          setSlash({ ...s, index: (s.index - 1 + s.items.length) % s.items.length })
          return true
        }
        if (event.key === 'ArrowDown') {
          setSlash({ ...s, index: (s.index + 1) % s.items.length })
          return true
        }
        if (event.key === 'Enter') {
          choose(s.items[s.index])
          return true
        }
        if (event.key === 'Escape') return true
        return false
      },
    }
  }

  const SlashCommands = useRef(
    Extension.create({
      name: 'slashCommand',
      addProseMirrorPlugins() {
        return [
          Suggestion<SlashItem>({
            pluginKey: new PluginKey('slash-command'),
            editor: this.editor,
            char: '/',
            startOfLine: false,
            allowSpaces: false,
            allow: ({ state, range }) => state.doc.resolve(range.from).parent.type.name !== 'codeBlock',
            items: ({ query }) => filterSlashItems(query),
            render: () => ({
              onStart: (p) => slashCtl.current?.open(p),
              onUpdate: (p) => slashCtl.current?.update(p),
              onExit: () => slashCtl.current?.close(),
              onKeyDown: (e) => slashCtl.current?.keydown(e) ?? false,
            }),
            command: ({ editor, range, props: item }) => {
              const chain = editor.chain().focus().deleteRange(range)
              // 块中间唤起：先拆块，新块应用类型（Notion 行为）；
              // 块首唤起：直接转换当前空块
              const $from = editor.state.doc.resolve(range.from)
              const before = editor.state.doc.textBetween($from.start(), range.from, '\n')
              if (before.trim()) chain.splitBlock()
              item.run(chain).run()
            },
          }),
        ]
      },
    }),
  ).current

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true },
        codeBlock: { defaultLanguage: null },
      }),
      TaskList,
      TaskItem.configure({ nested: false }),
      WikiLink,
      Placeholder.configure({ placeholder: '输入 / 唤起块菜单，开始写作……选中文字再点「插入待办」可基于选中片段建任务。' }),
      TrailingNode,
      SlashCommands,
    ],
    content: '',
    editorProps: {
      handleClick: (_view, _pos, event) => {
        const el = (event.target as HTMLElement | null)?.closest?.('[data-wiki]')
        if (!el) return false
        onWikiOpenRef.current?.(el.getAttribute('title') ?? el.textContent ?? '')
        return true
      },
    },
    onCreate: ({ editor: ed }) => {
      // 初始内容在 onCreate 里同步灌入，避免首帧空文档闪烁
      ed.commands.setContent(parseBodyToDoc(ed.schema, initialMarkdown))
      onReadyRef.current?.(ed)
    },
    onUpdate: ({ editor: ed }) => onChangeRef.current(serializeDocToMd(ed.state.doc)),
  })

  // 块定位：坐标 → 顶层块（嵌套列表项等向上归并到顶层块）
  function locateBlock(clientX: number, clientY: number): { pos: number; el: HTMLElement } | null {
    const ed = editor
    if (!ed) return null
    const coords = ed.view.posAtCoords({ left: clientX, top: clientY })
    if (!coords) return null
    const doc = ed.state.doc
    let p = coords.pos
    let $p = doc.resolve(p)
    while ($p.depth > 1) {
      p = $p.before($p.depth)
      $p = doc.resolve(p)
    }
    if ($p.depth < 1) return null
    const pos = $p.before(1)
    const el = ed.view.nodeDOM(pos)
    if (!el || !(el instanceof HTMLElement)) return null
    return { pos, el }
  }

  function clearDropMark(): void {
    markedEl.current?.classList.remove('drop-before', 'drop-after')
    markedEl.current = null
  }

  function applyDropMark(el: HTMLElement, zone: 'before' | 'after'): void {
    if (markedEl.current === el && el.classList.contains(zone === 'before' ? 'drop-before' : 'drop-after')) return
    clearDropMark()
    el.classList.add(zone === 'before' ? 'drop-before' : 'drop-after')
    markedEl.current = el
  }

  function moveBlock(srcPos: number, targetPos: number, zone: 'before' | 'after'): void {
    const ed = editor
    if (!ed) return
    const doc = ed.state.doc
    const node = doc.nodeAt(srcPos)
    const target = doc.nodeAt(targetPos)
    if (!node || !target || srcPos === targetPos) return
    const tr = ed.state.tr
    tr.delete(srcPos, srcPos + node.nodeSize)
    let insert = targetPos + (zone === 'after' ? target.nodeSize : 0)
    if (targetPos > srcPos) insert -= node.nodeSize
    tr.insert(insert, node)
    // 拖完选中该块 —— Notion 手感，也方便连续拖动
    tr.setSelection(NodeSelection.create(tr.doc, tr.doc.resolve(insert).before(1)))
    tr.scrollIntoView()
    ed.view.dispatch(tr)
  }

  // 卸载时清掉加在 PM 节点上的指示 class
  useEffect(() => clearDropMark, [])
  const rafMouse = useRef(0)
  const pendingMouse = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => () => { if (rafMouse.current) cancelAnimationFrame(rafMouse.current) }, [])

  return (
    <div
      ref={wrapRef}
      className="note-editor relative"
      onMouseMove={(e) => {
        if (dragSrc.current) return
        // rAF 节流：posAtCoords 每 mousemove 都跑在大文档下会卡，一帧一次足够跟手
        pendingMouse.current = { x: e.clientX, y: e.clientY }
        if (rafMouse.current) return
        rafMouse.current = requestAnimationFrame(() => {
          rafMouse.current = 0
          const p = pendingMouse.current
          if (!p) return
          const b = locateBlock(p.x, p.y)
          hoverBlock.current = b
          if (!b || !wrapRef.current) {
            if (handleMirror.current) setHandle(null)
            return
          }
          const top = b.el.getBoundingClientRect().top - wrapRef.current.getBoundingClientRect().top
          const prev = handleMirror.current
          if (!prev || prev.pos !== b.pos || Math.abs(prev.top - top) > 1) setHandle({ top, pos: b.pos })
        })
      }}
      onMouseLeave={() => { if (!dragSrc.current) setHandle(null) }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-shibei-block')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const b = locateBlock(e.clientX, e.clientY)
        if (!b) { clearDropMark(); return }
        const r = b.el.getBoundingClientRect()
        applyDropMark(b.el, e.clientY < r.top + r.height / 2 ? 'before' : 'after')
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('application/x-shibei-block')) return
        e.preventDefault()
        // 优先用 dragstart 记录的 src；为空时（拖出编辑器又拖回等边界）从 dataTransfer 兜底
        const fromData = Number(e.dataTransfer.getData('application/x-shibei-block'))
        const src = dragSrc.current ?? (Number.isInteger(fromData) && fromData >= 0 ? { pos: fromData } : null)
        dragSrc.current = null
        const b = locateBlock(e.clientX, e.clientY)
        clearDropMark()
        if (!src || !b) return
        const r = b.el.getBoundingClientRect()
        moveBlock(src.pos, b.pos, e.clientY < r.top + r.height / 2 ? 'before' : 'after')
      }}
      onDragLeave={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node | null)) clearDropMark()
      }}
    >
      <EditorContent editor={editor} />
      <button
        type="button"
        className="block-handle"
        style={handle ? { top: handle.top, opacity: 1 } : { top: -9999, opacity: 0 }}
        aria-label="选中或拖动块"
        title="拖动移动块；点击选中块"
        draggable
        onMouseDown={(e) => {
          e.preventDefault()
          const b = hoverBlock.current
          if (!b || !editor) return
          editor.chain().focus().setNodeSelection(b.pos).run()
        }}
        onDragStart={(e) => {
          const b = hoverBlock.current
          if (!b || !editor) { e.preventDefault(); return }
          dragSrc.current = { pos: b.pos }
          e.dataTransfer.setData('application/x-shibei-block', String(b.pos))
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setDragImage(b.el, 24, 12)
        }}
        onDragEnd={() => { dragSrc.current = null; clearDropMark() }}
      >⋮⋮</button>

      {slash && slash.items.length > 0 && slash.rect && (
        <div className="slash-menu card shadow-lg" style={{ left: slash.rect.left, top: slash.rect.top + 26 }} role="menu" aria-label="插入块">
          <div className="px-2.5 py-1.5 text-[11px] text-text-3">插入块 · /筛选</div>
          <ul>
            {slash.items.map((it, i) => (
              <li key={it.id}>
                <button
                  type="button"
                  role="menuitem"
                  className={i === slash.index ? 'active' : ''}
                  onMouseEnter={() => setSlash({ ...slash, index: i })}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    slashProps.current?.command(it)
                    slashProps.current = null
                    setSlash(null)
                  }}
                >
                  <span className="text-text-1">{it.label}</span>
                  <span className="text-text-3">{it.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
