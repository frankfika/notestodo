import { create } from 'zustand'

export type ViewName =
  | 'today'
  | 'meetings'
  | 'meeting-detail'
  | 'notes'
  | 'note-detail'
  | 'todos'
  | 'templates'
  | 'settings'

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
  goTemplates: () => void
  goSettings: () => void

  cmdkOpen: boolean
  setCmdkOpen: (open: boolean) => void

  sidebarCollapsed: boolean
  setSidebarCollapsed: (v: boolean) => void

  theme: 'dark' | 'light'
  setTheme: (t: 'dark' | 'light') => void
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
  goTemplates: () => set({ view: 'templates', meetingId: null, noteId: null }),
  goSettings: () => set({ view: 'settings', meetingId: null, noteId: null }),

  cmdkOpen: false,
  setCmdkOpen: (open) => set({ cmdkOpen: open }),

  sidebarCollapsed: false,
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),

  theme: 'dark',
  setTheme: (t) => {
    set({ theme: t })
    document.documentElement.classList.toggle('dark', t === 'dark')
  },
}))

export function applyTheme(t: 'dark' | 'light'): void {
  useUI.getState().setTheme(t)
}

// 开发模式：暴露 UI store 给 e2e 用来模拟导航（直接改 store 状态）
// 产线 tree-shake 掉。
if (import.meta.env.DEV) {
  ;(window as unknown as { __uiStore?: typeof useUI }).__uiStore = useUI
}
