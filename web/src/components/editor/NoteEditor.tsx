import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type ChainedCommands, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { Placeholder } from '@tiptap/extensions'
import { Extension } from '@tiptap/core'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { NodeSelection, PluginKey, TextSelection } from 'prosemirror-state'
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model'
import { parseBodyToDoc, serializeDocToMd } from '../../lib/noteMarkdown'
import { WikiLink } from './wikiLink'
import { db } from '../../db/db'
import type { ID, Note } from '../../types'

export interface NoteEditorProps {
  initialMarkdown: string
  onChange: (md: string) => void
  onReady?: (editor: Editor) => void
  /** 点击 [[双链]] 时回调（参数是链接目标标题）；不传则链接不可点 */
  onWikiOpen?: (title: string) => void
  /** 当前页面 id（块「移动到…」时排除自身）；不传则隐藏移动入口 */
  currentNoteId?: ID
  /** 块移动回调：编辑器已删除块并把块的 markdown 交给页面追加到目标 */
  onMoveBlockToNote?: (blockMd: string, targetNoteId: ID) => void
}

// ── 斜杠菜单 / Turn into 共用的块定义 ─────────────────────────────

interface SlashItem {
  id: string
  label: string
  hint: string
  keys: string
  group: '文本' | '标题' | '列表' | '插入'
  run: (ch: ChainedCommands) => ChainedCommands
}

const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', label: '正文', hint: '普通段落', keys: 'text p zhengwen', group: '文本', run: (ch) => ch.setParagraph() },
  { id: 'h1', label: '一级标题', hint: '# 大标题', keys: 'h1 heading biaoti', group: '标题', run: (ch) => ch.toggleHeading({ level: 1 }) },
  { id: 'h2', label: '二级标题', hint: '## 小节', keys: 'h2 heading biaoti', group: '标题', run: (ch) => ch.toggleHeading({ level: 2 }) },
  { id: 'h3', label: '三级标题', hint: '### 子节', keys: 'h3 heading biaoti', group: '标题', run: (ch) => ch.toggleHeading({ level: 3 }) },
  {
    id: 'todo', label: '待办列表', hint: '可勾选的清单', keys: 'todo task checkbox daiban', group: '列表',
    run: (ch) => ch.insertContent({
      type: 'taskList',
      content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] }],
    }),
  },
  { id: 'bullet', label: '无序列表', hint: '• 圆点列表', keys: 'bullet ul list liebiao', group: '列表', run: (ch) => ch.toggleBulletList() },
  { id: 'ordered', label: '有序列表', hint: '1. 编号列表', keys: 'ol number list liebiao', group: '列表', run: (ch) => ch.toggleOrderedList() },
  { id: 'quote', label: '引用', hint: '左侧竖线引用', keys: 'quote yinyong', group: '插入', run: (ch) => ch.toggleBlockquote() },
  { id: 'code', label: '代码块', hint: '等宽字体片段', keys: 'code daima', group: '插入', run: (ch) => ch.toggleCodeBlock() },
  { id: 'divider', label: '分割线', hint: '一条横线', keys: 'hr divider fenge', group: '插入', run: (ch) => ch.setHorizontalRule() },
]

/** Turn into 矩阵：块类型 → 允许转换的目标（见 spec §A）。列表只在同级互转 + 拆回文本。 */
const TURN_INTO: Record<string, string[]> = {
  paragraph: ['h1', 'h2', 'h3', 'todo', 'bullet', 'ordered', 'quote', 'code'],
  heading: ['text', 'h1', 'h2', 'h3', 'todo', 'bullet', 'ordered', 'quote', 'code'],
  blockquote: ['text', 'h1', 'h2', 'h3', 'todo', 'bullet', 'ordered', 'code'],
  codeBlock: ['text', 'h1', 'h2', 'h3', 'quote'],
  bulletList: ['ordered', 'todo', 'text', 'quote', 'code'],
  orderedList: ['bullet', 'todo', 'text', 'quote', 'code'],
  taskList: ['bullet', 'ordered', 'text', 'quote', 'code'],
}

// ponytail: 块颜色存 PM 节点 attr，markdown 往返会丢（md 无颜色语法）；
// 要持久化时换带 front-matter 的序列化或独立存储。
const BLOCK_COLORS: { id: string | null; label: string }[] = [
  { id: null, label: '默认' },
  { id: 'gray', label: '灰色' },
  { id: 'brown', label: '棕色' },
  { id: 'orange', label: '橙色' },
  { id: 'yellow', label: '黄色' },
  { id: 'green', label: '绿色' },
  { id: 'blue', label: '蓝色' },
  { id: 'purple', label: '紫色' },
  { id: 'red', label: '红色' },
]

/** 块级颜色：全局 attr，渲染为 data-color，样式在 main.css */
const BlockColor = Extension.create({
  name: 'blockColor',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'taskList'],
        attributes: {
          color: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-color'),
            renderHTML: (attrs) => (attrs.color ? { 'data-color': attrs.color } : {}),
          },
        },
      },
    ]
  },
})

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

/** 把任意顶层块展平成段落序列（转换时保留全部文字） */
function paragraphsOf(node: PMNode): PMNode[] {
  const para = node.type.schema.nodes.paragraph
  if (node.type.name === 'codeBlock') {
    const lines = node.textContent.split('\n')
    return lines.map((l) => para.create(null, l ? node.type.schema.text(l) : null))
  }
  if (node.isTextblock) return [para.create(null, node.content)]
  const out: PMNode[] = []
  node.forEach((child) => out.push(...paragraphsOf(child)))
  return out.length ? out : [para.create()]
}

/** 用段落序列造目标类型的块；heading 只吃第一段，其余段跟在后面 */
function buildBlock(itemId: string, paras: PMNode[]): PMNode[] {
  const n = paras[0]!.type.schema.nodes
  switch (itemId) {
    case 'h1':
    case 'h2':
    case 'h3':
      return [n.heading.create({ level: Number(itemId[1]) }, paras[0]!.content), ...paras.slice(1)]
    case 'quote':
      return [n.blockquote.create(null, paras)]
    case 'code': {
      const text = paras.map((p) => p.textContent).join('\n')
      return [n.codeBlock.create(null, text ? paras[0]!.type.schema.text(text) : null)]
    }
    case 'bullet':
      return [n.bulletList.create(null, paras.map((p) => n.listItem.create(null, p)))]
    case 'ordered':
      return [n.orderedList.create(null, paras.map((p) => n.listItem.create(null, p)))]
    case 'todo':
      return [n.taskList.create(null, paras.map((p) => n.taskItem.create({ checked: false }, p)))]
    default:
      return paras
  }
}

// ponytail: 选中多个块的框选不做；跨块文本选择原生支持，块级拖动是单块。
// 需要多块框选时参考 BlockNote 的块选择插件，那是一个独立的 PM 插件量级。

export default function NoteEditor({ initialMarkdown, onChange, onReady, onWikiOpen, currentNoteId, onMoveBlockToNote }: NoteEditorProps): JSX.Element {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onWikiOpenRef = useRef(onWikiOpen)
  onWikiOpenRef.current = onWikiOpen
  const onMoveRef = useRef(onMoveBlockToNote)
  onMoveRef.current = onMoveBlockToNote

  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<{ top: number; pos: number } | null>(null)
  const handleMirror = useRef(handle)
  handleMirror.current = handle
  const hoverBlock = useRef<{ pos: number; el: HTMLElement } | null>(null)
  const dragSrc = useRef<{ pos: number } | null>(null)
  const markedEl = useRef<HTMLElement | null>(null)

  // 块手柄菜单：root → turn/color/move 子面板
  const [menu, setMenu] = useState<{ top: number; pos: number; section: 'root' | 'turn' | 'color' | 'move' } | null>(null)
  const [moveTargets, setMoveTargets] = useState<Note[]>([])

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
              // Notion 语义：删掉 /query 后就地转换当前块（TipTap toggle 命令天然如此）；
              // 分割线等无文本块为插入式
              editor.chain().focus().deleteRange(range).run()
              item.run(editor.chain()).run()
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
      BlockColor,
      Placeholder.configure({ placeholder: '写点什么，或输入 / 唤起命令……选中文字再点「插入待办」可基于选中片段建任务。' }),
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

  // 点击菜单外任意处关闭手柄菜单
  useEffect(() => {
    if (!menu) return
    const onDocDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [menu])

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

  function turnInto(pos: number, itemId: string): void {
    const ed = editor
    if (!ed) return
    const node = ed.state.doc.nodeAt(pos)
    if (!node) return
    const nodes = buildBlock(itemId, paragraphsOf(node))
    const tr = ed.state.tr.replace(pos, pos + node.nodeSize, new Slice(Fragment.from(nodes), 0, 0))
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos + 1, tr.doc.content.size))))
    tr.scrollIntoView()
    ed.view.dispatch(tr)
    setMenu(null)
  }

  function setBlockColor(pos: number, color: string | null): void {
    const ed = editor
    if (!ed) return
    const node = ed.state.doc.nodeAt(pos)
    if (!node) return
    ed.chain().focus().setNodeSelection(pos).updateAttributes(node.type.name, { color }).run()
    setMenu(null)
  }

  function deleteBlock(pos: number): void {
    const ed = editor
    if (!ed) return
    const node = ed.state.doc.nodeAt(pos)
    if (!node) return
    const tr = ed.state.tr.delete(pos, pos + node.nodeSize)
    ed.view.dispatch(tr)
    setMenu(null)
    setHandle(null)
  }

  function moveBlockTo(pos: number, targetId: ID): void {
    const ed = editor
    if (!ed) return
    const node = ed.state.doc.nodeAt(pos)
    if (!node) return
    const md = serializeDocToMd(ed.schema.topNodeType.create(null, node)).trim()
    const tr = ed.state.tr.delete(pos, pos + node.nodeSize)
    ed.view.dispatch(tr)
    setMenu(null)
    setHandle(null)
    onMoveRef.current?.(md, targetId)
  }

  function openMoveSection(): void {
    setMenu((m) => m && { ...m, section: 'move' })
    void db.notes
      .filter((n) => n.deleted_at === null && n.id !== currentNoteId)
      .toArray()
      .then((ns) => setMoveTargets(ns.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 20)))
  }

  // 卸载时清掉加在 PM 节点上的指示 class
  useEffect(() => clearDropMark, [])
  const rafMouse = useRef(0)
  const pendingMouse = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => () => { if (rafMouse.current) cancelAnimationFrame(rafMouse.current) }, [])

  const menuNode = menu && editor ? editor.state.doc.nodeAt(menu.pos) : null
  const turnTargets = menuNode ? (TURN_INTO[menuNode.type.name] ?? []) : []
  const itemById = (id: string): SlashItem => SLASH_ITEMS.find((it) => it.id === id)!

  return (
    <div
      ref={wrapRef}
      className="note-editor relative"
      onMouseMove={(e) => {
        if (dragSrc.current || menu) return
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
      onMouseLeave={() => { if (!dragSrc.current && !menu) setHandle(null) }}
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
        aria-label="块菜单：点击打开，拖动移动"
        title="点击打开块菜单；拖动移动块"
        draggable
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!handle) return
          setMenu((m) => (m && m.pos === handle.pos ? null : { top: handle.top, pos: handle.pos, section: 'root' }))
        }}
        onDragStart={(e) => {
          const b = hoverBlock.current ?? (handle ? locateBlockAtPos(handle.pos) : null)
          if (!b || !editor) { e.preventDefault(); return }
          setMenu(null)
          dragSrc.current = { pos: b.pos }
          e.dataTransfer.setData('application/x-shibei-block', String(b.pos))
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setDragImage(b.el, 24, 12)
        }}
        onDragEnd={() => { dragSrc.current = null; clearDropMark() }}
      >⋮⋮</button>

      {menu && (
        <div ref={menuRef} className="block-menu card shadow-lg" style={{ top: menu.top + 24 }} role="menu" aria-label="块菜单">
          {menu.section === 'root' && (
            <ul>
              {turnTargets.length > 0 && (
                <li><button type="button" role="menuitem" onClick={() => setMenu({ ...menu, section: 'turn' })}>转换为<span className="ml-auto text-text-3">▸</span></button></li>
              )}
              <li><button type="button" role="menuitem" onClick={() => setMenu({ ...menu, section: 'color' })}>颜色<span className="ml-auto text-text-3">▸</span></button></li>
              <li><button type="button" role="menuitem" disabled className="opacity-50 cursor-not-allowed">评论<span className="ml-auto text-[10px] text-text-3">即将推出</span></button></li>
              {onMoveBlockToNote && (
                <li><button type="button" role="menuitem" onClick={openMoveSection}>移动到…<span className="ml-auto text-text-3">▸</span></button></li>
              )}
              <li className="border-t border-line mt-1 pt-1">
                <button type="button" role="menuitem" className="text-danger" onClick={() => deleteBlock(menu.pos)}>删除块</button>
              </li>
            </ul>
          )}
          {menu.section === 'turn' && (
            <ul>
              <li><button type="button" className="text-text-3" onClick={() => setMenu({ ...menu, section: 'root' })}>← 转换为</button></li>
              {turnTargets.map((id) => (
                <li key={id}>
                  <button type="button" role="menuitem" onClick={() => turnInto(menu.pos, id)}>
                    {itemById(id).label}<span className="ml-auto text-text-3">{itemById(id).hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {menu.section === 'color' && (
            <ul>
              <li><button type="button" className="text-text-3" onClick={() => setMenu({ ...menu, section: 'root' })}>← 颜色</button></li>
              {BLOCK_COLORS.map((c) => (
                <li key={c.id ?? 'default'}>
                  <button type="button" role="menuitem" onClick={() => setBlockColor(menu.pos, c.id)}>
                    <span className={`color-dot${c.id ? ` color-${c.id}` : ''}`} />{c.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {menu.section === 'move' && (
            <ul>
              <li><button type="button" className="text-text-3" onClick={() => setMenu({ ...menu, section: 'root' })}>← 移动到…</button></li>
              {moveTargets.length === 0 && <li className="px-3 py-2 text-[12px] text-text-3">没有其它页面</li>}
              {moveTargets.map((n) => (
                <li key={n.id}>
                  <button type="button" role="menuitem" className="truncate" onClick={() => moveBlockTo(menu.pos, n.id)}>
                    {n.title || '无标题'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {slash && slash.items.length > 0 && slash.rect && (
        <div className="slash-menu card shadow-lg" style={{ left: slash.rect.left, top: slash.rect.top + 26 }} role="menu" aria-label="插入块">
          <div className="px-2.5 py-1.5 text-[11px] text-text-3">插入 / 转换块 · /筛选</div>
          <ul>
            {slash.items.map((it, i) => (
              <li key={it.id}>
                {(i === 0 || slash.items[i - 1].group !== it.group) && (
                  <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] text-text-3">{it.group}</div>
                )}
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

  /** 拖拽前 hover 可能还没就绪，从已知 pos 反查 DOM */
  function locateBlockAtPos(pos: number): { pos: number; el: HTMLElement } | null {
    const ed = editor
    if (!ed) return null
    const el = ed.view.nodeDOM(pos)
    return el instanceof HTMLElement ? { pos, el } : null
  }
}
