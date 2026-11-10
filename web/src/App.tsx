import { useEffect } from 'react'
import { useUI } from './state/ui'
import { useRecorder } from './state/recorder'
import { throwOnNextRenderForTest } from './components/ErrorBoundary'
import Sidebar, { BottomTabBar } from './components/Sidebar'
import RecordingBar from './components/RecordingBar'
import CommandPalette from './components/CommandPalette'
import ShortcutsCheatsheet from './components/ShortcutsCheatsheet'
import Onboarding from './components/Onboarding'
import AiPanel from './components/AiPanel'
import InstallBanner from './components/InstallBanner'
import PermissionGuide from './components/PermissionGuide'
import ErrorBoundary from './components/ErrorBoundary'
import ToastHost from './components/ToastHost'
import MeetingsPage from './pages/meetings/MeetingsPage'
import MeetingDetailPage from './pages/meeting/MeetingDetailPage'
import NotesPage from './pages/notes/NotesPage'
import NoteDetailPage from './pages/notes/NoteDetailPage'
import TodosPage from './pages/todos/TodosPage'
import BoardPage from './pages/board/BoardPage'
import ReportPage from './pages/report/ReportPage'
import TemplatesPage from './pages/templates/TemplatesPage'
import SettingsPage from './pages/settings/SettingsPage'
import AiHomePage from './pages/ai/AiHomePage'
import TodayPage from './pages/today/TodayPage'
import { installSyncHooks } from './sync/outbox'
import { syncNow } from './sync/engine'
import { getSettings } from './db/settings'

export default function App() {
  const view = useUI((s) => s.view)
  const setCmdkOpen = useUI((s) => s.setCmdkOpen)
  const setAiOpen = useUI((s) => s.setAiOpen)
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

  // 一开录就进会中速记视图（无论从今天 / 日历 / ⌘⇧R 哪里开始），不用再找入口
  useEffect(() => useRecorder.subscribe((s, prev) => {
    if (s.meeting && s.meeting.id !== prev.meeting?.id) useUI.getState().goMeeting(s.meeting.id)
  }), [])

  // 全局快捷键：⌘K 命令面板 + ⌘⇧R 录制切换
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdkOpen(true)
        return
      }
      if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setAiOpen(!useUI.getState().aiOpen)
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
  }, [setCmdkOpen, setAiOpen, phase, start, stop])

  // 多端同步：启动即挂 Dexie hook（此后所有本地改动自动进发件箱）；
  // 启用时每 60s 检查一次，按设置的间隔自动同步，联网恢复时也立刻补一次。
  useEffect(() => {
    installSyncHooks()
    let lastRun = 0
    const tick = async (): Promise<void> => {
      const s = await getSettings()
      if (!s.sync_enabled || !s.sync_server_url || !s.sync_token) return
      if (document.visibilityState !== 'visible' || !navigator.onLine) return
      if (Date.now() - lastRun < Math.max(1, s.sync_interval_min) * 60_000) return
      lastRun = Date.now()
      await syncNow()
    }
    const timer = window.setInterval(() => void tick(), 60_000)
    const onOnline = (): void => {
      lastRun = 0
      void tick()
    }
    window.addEventListener('online', onOnline)
    void tick()
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  return (
    <ErrorBoundary>
      <div className="flex h-full">
        <Sidebar />
        <main className="flex-1 min-w-0 flex flex-col pb-16 md:pb-0">
          <RecordingBar />
          <div key={view} className="page-enter flex-1 min-h-0 overflow-hidden">
            {view === 'today' && <TodayPage />}
            {view === 'ai' && <AiHomePage />}
            {view === 'meetings' && <MeetingsPage />}
            {view === 'meeting-detail' && <MeetingDetailPage />}
            {view === 'notes' && <NotesPage />}
            {view === 'note-detail' && <NoteDetailPage />}
            {view === 'todos' && <TodosPage />}
            {view === 'board' && <BoardPage />}
            {view === 'report' && <ReportPage />}
            {view === 'templates' && <TemplatesPage />}
            {view === 'settings' && <SettingsPage />}
          </div>
        </main>
        <BottomTabBar />
        <CommandPalette />
        <ShortcutsCheatsheet />
        <AiPanel />
        <InstallBanner />
        <Onboarding />
        <PermissionGuide />
        <ToastHost />
      </div>
    </ErrorBoundary>
  )
}
