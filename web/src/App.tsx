import { useEffect } from 'react'
import { useUI } from './state/ui'
import { useRecorder } from './state/recorder'
import { throwOnNextRenderForTest } from './components/ErrorBoundary'
import Sidebar, { BottomTabBar } from './components/Sidebar'
import RecordingBar from './components/RecordingBar'
import CommandPalette from './components/CommandPalette'
import Onboarding from './components/Onboarding'
import PermissionGuide from './components/PermissionGuide'
import ErrorBoundary from './components/ErrorBoundary'
import TodayPage from './pages/today/TodayPage'
import MeetingsPage from './pages/meetings/MeetingsPage'
import MeetingDetailPage from './pages/meeting/MeetingDetailPage'
import NotesPage from './pages/notes/NotesPage'
import NoteDetailPage from './pages/notes/NoteDetailPage'
import TodosPage from './pages/todos/TodosPage'
import TemplatesPage from './pages/templates/TemplatesPage'
import SettingsPage from './pages/settings/SettingsPage'

export default function App() {
  const view = useUI((s) => s.view)
  const setCmdkOpen = useUI((s) => s.setCmdkOpen)
  const start = useRecorder((s) => s.start)
  const stop = useRecorder((s) => s.stop)
  const phase = useRecorder((s) => s.phase)

  // DEV-only 测试钩子：错误边界 e2e 通过它触发一次 render 时抛错
  // 用 useEffect 在挂载后跑（避免 StrictMode 双 render 时立即重置 flag）
  useEffect(() => {
    if (throwOnNextRenderForTest()) {
      // 在 effect 里同步抛 — React 会重新渲染并由外层 ErrorBoundary 接管
      throw new Error('ErrorBoundary e2e — simulated render failure')
    }
  }, [])

  // 全局快捷键：⌘K 命令面板 + ⌘⇧R 录制切换
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdkOpen(true)
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        if (phase === 'recording') void stop()
        else void start()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCmdkOpen, phase, start, stop])

  return (
    <ErrorBoundary>
      <div className="flex h-full">
        <Sidebar />
        <main className="flex-1 min-w-0 flex flex-col pb-16 md:pb-0">
          <RecordingBar />
          <div key={view} className="page-enter flex-1 min-h-0 overflow-hidden">
            {view === 'today' && <TodayPage />}
            {view === 'meetings' && <MeetingsPage />}
            {view === 'meeting-detail' && <MeetingDetailPage />}
            {view === 'notes' && <NotesPage />}
            {view === 'note-detail' && <NoteDetailPage />}
            {view === 'todos' && <TodosPage />}
            {view === 'templates' && <TemplatesPage />}
            {view === 'settings' && <SettingsPage />}
          </div>
        </main>
        <BottomTabBar />
        <CommandPalette />
        <Onboarding />
        <PermissionGuide />
      </div>
    </ErrorBoundary>
  )
}
