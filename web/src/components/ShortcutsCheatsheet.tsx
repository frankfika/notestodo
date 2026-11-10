import { useEffect } from 'react'
import { useUI } from '../state/ui'
import { mod } from '../lib/id'

interface ShortcutRow {
  /** 按键序列，逐个渲染成 kbd chip */
  keys: string[]
  desc: string
}

interface ShortcutGroup {
  name: string
  rows: ShortcutRow[]
}

/** 用户正在打字（input / textarea / select / contentEditable）时不响应 ? */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true
}

/**
 * 快捷键速查卡：按 ? 打开，Esc 关闭。
 * 视觉沿用命令面板（同一套设计语言），内容跟着 App 里注册的快捷键走。
 */
export default function ShortcutsCheatsheet(): JSX.Element | null {
  const open = useUI((s) => s.shortcutsOpen)
  const setOpen = useUI((s) => s.setShortcutsOpen)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (useUI.getState().shortcutsOpen) setOpen(false)
        return
      }
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return
      if (isTyping(e.target)) return
      setOpen(!useUI.getState().shortcutsOpen)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])

  if (!open) return null

  const m = mod()
  const groups: ShortcutGroup[] = [
    {
      name: '全局',
      rows: [
        { keys: [m, 'K'], desc: '命令面板（搜索 + 跳转）' },
        { keys: [m, 'J'], desc: 'AI 助手' },
        { keys: [m, '⇧', 'R'], desc: '开始 / 停止录音' },
        { keys: ['?'], desc: '打开 / 关闭这张速查卡' },
        { keys: ['Esc'], desc: '关闭弹层' },
      ],
    },
    {
      name: '行内编辑',
      rows: [
        { keys: ['Enter'], desc: '保存' },
        { keys: ['Esc'], desc: '取消' },
        { keys: ['Enter'], desc: '保存并新建同级（连打）' },
        { keys: ['Tab'], desc: '缩进为上一个同级的子任务' },
        { keys: ['⇧', 'Tab'], desc: '提升一级' },
      ],
    },
    {
      name: '任务列表',
      rows: [
        { keys: ['↑', '↓'], desc: '在任务行之间移动' },
        { keys: ['Enter'], desc: '编辑选中的任务' },
        { keys: ['Space'], desc: '勾选完成 / 取消完成' },
        { keys: ['⌫'], desc: '删除（可撤销）' },
      ],
    },
  ]

  return (
    <div
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] bg-scrim backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="快捷键"
        className="w-[520px] max-w-[92vw] rounded-2xl border border-line-strong bg-bg-raise shadow-2xl overflow-hidden"
      >
        <div className="flex items-center px-4 py-3 border-b border-line">
          <span className="text-sm font-medium text-text-1">快捷键</span>
          <span className="ml-2 text-[11px] text-text-3">按 ? 随时唤出</span>
          <button
            onClick={() => setOpen(false)}
            aria-label="关闭"
            className="icon-btn ml-auto !h-6 !w-6 text-xs"
          >✕</button>
        </div>
        <div className="py-2">
          {groups.map((g) => (
            <div key={g.name} className="py-1">
              <div className="px-4 pt-2 pb-1 text-[11px] font-semibold text-text-3 tracking-widest">{g.name}</div>
              {g.rows.map((r) => (
                <div key={r.desc} className="flex items-center gap-3 px-4 py-1.5 text-sm">
                  <span className="flex-1 min-w-0 text-text-2">{r.desc}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {r.keys.map((k) => <span key={k} className="kbd">{k}</span>)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
