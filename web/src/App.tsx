import { useEffect } from 'react'
import { useUI } from './state/ui'
import Sidebar from './components/Sidebar'
import RecordingBar from './components/RecordingBar'
import CommandPalette from './components/CommandPalette'
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

  // 全局快捷键：⌘K 命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdkOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCmdkOpen])

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 min-w-0 flex flex-col">
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
      <CommandPalette />
    </div>
  )
}
