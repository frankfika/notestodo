import { create } from 'zustand'

export type ViewName =
  | 'today'
  | 'meetings'
  | 'meeting-detail'
  | 'notes'
  | 'note-detail'
  | 'todos'
  | 'board'
  | 'report'
  | 'templates'
  | 'settings'

/** 任务页的视角：看板与三种 OKR 视图是同一份数据 */
export type TaskMode = 'board' | 'focus' | 'quarter' | 'strategy'

export interface RouteState {
  view: ViewName
  meetingId: string | null
  noteId: string | null
  todoFocusId: string | null
}

interface UIStore extends RouteState {
  route: (r: Partial<RouteState>) => void
  goToday: () => void
  goMeetings: () => void
  goMeeting: (meetingId: string) => void
  goNotes: () => void
  goNote: (noteId: string) => void
  goTodos: (todoFocusId?: string) => void
  /** 任务页内切视角（看板走 board 路由，其余走 todos） */
  taskMode: Exclude<TaskMode, 'board'>
  goTaskMode: (m: TaskMode) => void
  goBoard: () => void
  goReport: () => void
  goTemplates: () => void
  goSettings: () => void

  cmdkOpen: boolean
  setCmdkOpen: (open: boolean) => void

  permGuideOpen: boolean
  setPermGuideOpen: (open: boolean) => void

  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean) => void

  theme: 'dark' | 'light' | 'system'
  setTheme: (t: 'dark' | 'light' | 'system') => void
}

export const useUI = create<UIStore>((set) => ({
  view: 'today',
  meetingId: null,
  noteId: null,
  todoFocusId: null,

  route: (r) => set(r),
  goToday: () => set({ view: 'today', meetingId: null, noteId: null, todoFocusId: null }),
  goMeetings: () => set({ view: 'meetings', meetingId: null, noteId: null }),
  goMeeting: (meetingId) => set({ view: 'meeting-detail', meetingId, noteId: null }),
  goNotes: () => set({ view: 'notes', meetingId: null, noteId: null }),
  goNote: (noteId) => set({ view: 'note-detail', meetingId: null, noteId }),
  goTodos: (todoFocusId) => set({ view: 'todos', meetingId: null, noteId: null, todoFocusId: todoFocusId ?? null }),
  goBoard: () => set({ view: 'board', meetingId: null, noteId: null }),
  taskMode: 'focus',
  goTaskMode: (m) => set(m === 'board'
    ? { view: 'board', meetingId: null, noteId: null }
    : { view: 'todos', taskMode: m, meetingId: null, noteId: null, todoFocusId: null }),
  goReport: () => set({ view: 'report', meetingId: null, noteId: null }),
  goTemplates: () => set({ view: 'templates', meetingId: null, noteId: null }),
  goSettings: () => set({ view: 'settings', meetingId: null, noteId: null }),

  cmdkOpen: false,
  setCmdkOpen: (open) => set({ cmdkOpen: open }),

  permGuideOpen: false,
  setPermGuideOpen: (open) => set({ permGuideOpen: open }),

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
