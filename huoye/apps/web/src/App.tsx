import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { api } from "./lib/api";
import { AppShell } from "./components/AppShell";
import { AssistantPage } from "./pages/AssistantPage";
import { ChatPage } from "./pages/ChatPage";
import { MemoriesPage } from "./pages/MemoriesPage";
import { MemoryEditorPage } from "./pages/MemoryEditorPage";
import { MemoryFolderPage, MemoryRoutePage } from "./pages/MemoryFolderPage";
import { HealthPage } from "./pages/HealthPage";
import { RecordingsPage } from "./pages/RecordingsPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { TaskNewPage } from "./pages/TaskNewPage";
import { TasksPage } from "./pages/TasksPage";
import { TodayPage } from "./pages/TodayPage";

export default function App() {
  const location = useLocation();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });

  if (settings.isLoading) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }} className="hy-muted">
        正在打开活页…
      </div>
    );
  }

  const onboarded = settings.data?.onboardingCompleted;
  if (!onboarded && !location.pathname.startsWith("/onboarding")) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <Routes>
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route element={<AppShell assistantName={settings.data?.assistantName ?? "叶"} />}>
        <Route path="/" element={<Navigate to="/today" replace />} />
        <Route path="/today" element={<TodayPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/new" element={<TaskNewPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/memories" element={<MemoriesPage />} />
        <Route path="/memories/health" element={<HealthPage />} />
        <Route path="/memories/health/:date" element={<HealthPage />} />
        <Route path="/memories/recordings" element={<RecordingsPage />} />
        <Route path="/memories/recordings/:id" element={<RecordingsPage />} />
        <Route path="/memories/diaries/:date" element={<MemoryEditorPage />} />
        <Route path="/memories/about-you" element={<MemoryFolderPage />} />
        <Route path="/memories/diaries" element={<MemoryFolderPage />} />
        <Route path="/memories/uploads" element={<MemoryFolderPage />} />
        <Route path="/memories/*" element={<MemoryRoutePage />} />
        <Route path="/assistant" element={<AssistantPage />} />
        <Route path="/settings/*" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
