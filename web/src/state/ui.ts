import { create } from 'zustand'

export type ViewName =
  | 'today'
  | 'ai'
  | 'meetings'
  | 'meeting-detail'
  | 'notes'
  | 'note-detail'
  | 'todos'
  | 'board'
  | 'report'
  | 'templates'
  | 'settings'

export interface RouteState {
  view: ViewName
  meetingId: string | null
  noteId: string | null
  todoFocusId: string | null
}

/* ── 记住上次所在页面 ──────────────────────────────────────────────
   刷新 / 崩溃恢复时回到原地，而不是一律弹回落地页（会议中途刷新尤其烦）。
   用 sessionStorage 而不是 localStorage：刷新保留，关掉应用重开就没有了 ——
   每天重新打开仍从「今天」开始，这才是落地页该有的行为。
   只记顶层页面：详情页带 id，刷新后那个 id 可能已经失效。 */
const LAST_VIEW_KEY = 'openNotion.lastView.v1'
const PERSISTABLE: ViewName[] = ['today', 'ai', 'meetings', 'notes', 'todos', 'board', 'report', 'templates', 'settings']

function readLastView(): ViewName {
  if (typeof window === 'undefined') return 'today'
  try {
    const v = window.sessionStorage.getItem(LAST_VIEW_KEY)
    return v && (PERSISTABLE as string[]).includes(v) ? (v as ViewName) : 'today'
  } catch {
    return 'today'
  }
}

interface UIStore extends RouteState {
  route: (r: Partial<RouteState>) => void
  goToday: () => void
  goAi: () => void
  goMeetings: () => void
  goMeeting: (meetingId: string) => void
  goNotes: () => void
  goNote: (noteId: string) => void
  goTodos: (todoFocusId?: string) => void
  goBoard: () => void
  goReport: () => void
  goTemplates: () => void
  goSettings: () => void

  cmdkOpen: boolean
  setCmdkOpen: (open: boolean) => void

  aiOpen: boolean
  setAiOpen: (open: boolean) => void

  permGuideOpen: boolean
  setPermGuideOpen: (open: boolean) => void

  /** 快捷键速查卡（? 打开） */
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void

  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean) => void

  theme: 'dark' | 'light' | 'system'
  setTheme: (t: 'dark' | 'light' | 'system') => void
}

export const useUI = create<UIStore>((set) => ({
  // 落地页是「今天」：先看到今天要做什么，而不是直接甩一个 AI 输入框
  // （首次访问；之后记住上次所在页面，见下方 readLastView）
  view: readLastView(),
  meetingId: null,
  noteId: null,
  todoFocusId: null,

  route: (r) => set(r),
  goToday: () => set({ view: 'today', meetingId: null, noteId: null, todoFocusId: null }),
  goAi: () => set({ view: 'ai', meetingId: null, noteId: null, todoFocusId: null }),
  goMeetings: () => set({ view: 'meetings', meetingId: null, noteId: null }),
  goMeeting: (meetingId) => set({ view: 'meeting-detail', meetingId, noteId: null }),
  goNotes: () => set({ view: 'notes', meetingId: null, noteId: null }),
  goNote: (noteId) => set({ view: 'note-detail', meetingId: null, noteId }),
  goTodos: (todoFocusId) => set({ view: 'todos', meetingId: null, noteId: null, todoFocusId: todoFocusId ?? null }),
  goBoard: () => set({ view: 'board', meetingId: null, noteId: null }),
  goReport: () => set({ view: 'report', meetingId: null, noteId: null }),
  goTemplates: () => set({ view: 'templates', meetingId: null, noteId: null }),
  goSettings: () => set({ view: 'settings', meetingId: null, noteId: null }),

  cmdkOpen: false,
  setCmdkOpen: (open) => set({ cmdkOpen: open }),

  aiOpen: false,
  setAiOpen: (open) => set({ aiOpen: open }),

  permGuideOpen: false,
  setPermGuideOpen: (open) => set({ permGuideOpen: open }),

  shortcutsOpen: false,
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

  sidebarCollapsed: false,
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),

  theme: 'light',
  setTheme: (t) => {
    set({ theme: t })
    const resolved = t === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : t
    document.documentElement.classList.toggle('dark', resolved === 'dark')
  },
}))

// 页面切换时记住位置（只记顶层页面）
if (typeof window !== 'undefined') {
  useUI.subscribe((s) => {
    if (!PERSISTABLE.includes(s.view)) return
    try {
      window.sessionStorage.setItem(LAST_VIEW_KEY, s.view)
    } catch {
      // 隐私模式 / 配额满 —— 记不住无所谓，忽略
    }
  })
}

// 监听系统主题变化 —— 选「system」的用户在 OS 切换深/浅时立即跟随
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = (): void => {
    if (useUI.getState().theme === 'system') {
      applyTheme('system') // 触发 resolved + DOM toggle
    }
  }
  if (mq.addEventListener) mq.addEventListener('change', onChange)
  else if ((mq as unknown as { addListener?: (cb: () => void) => void }).addListener) {
    (mq as unknown as { addListener: (cb: () => void) => void }).addListener(onChange)
  }
}

export function applyTheme(t: 'dark' | 'light' | 'system'): void {
  useUI.getState().setTheme(t)
}

// 开发模式：暴露 UI store 给 e2e 用来模拟导航（直接改 store 状态）
// 产线 tree-shake 掉。
if (import.meta.env.DEV) {
  ;(window as unknown as { __uiStore?: typeof useUI }).__uiStore = useUI
}
