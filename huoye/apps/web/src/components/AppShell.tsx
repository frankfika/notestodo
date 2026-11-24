import { Mark } from "@huoye/ui";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../lib/api";
import { Composer } from "./Composer";
import { ProactiveNotifier } from "./ProactiveNotifier";
import "../today.css";

const NAV = [
  { to: "/today", label: "今天", placeholder: "整理今天…" },
  { to: "/chat", label: "聊天", placeholder: "和叶聊聊…" },
  { to: "/tasks", label: "任务", placeholder: "交待一项任务…" },
  { to: "/memories", label: "记忆", placeholder: "告诉我更多关于你的事…" },
  { to: "/assistant", label: "助手", placeholder: "和叶聊聊…" },
];

/** 宽屏顶栏：一排安静的胶囊标签，选中项略深的半透明白底 + 深墨色。 */
const tabClass = (isActive: boolean) =>
  `hy-shell-tab no-underline ${isActive ? "hy-shell-tab-active" : ""}`;

/** 窄屏底栏：悬浮胶囊 Tab，选中项略深。 */
const mobileTabClass = (isActive: boolean) =>
  `hy-mobile-nav-tab no-underline ${isActive ? "hy-mobile-nav-tab-active" : ""}`;

export function AppShell({ assistantName }: { assistantName: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const current = NAV.find((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)) ?? NAV[0];
  const placeholder = (current?.placeholder ?? "和叶聊聊…").replace("叶", assistantName);
  // 今天页自带右栏对话与悬浮输入，不再叠一层贴底表单。
  const isToday = location.pathname === "/today" || location.pathname === "/";
  const hideComposer =
    isToday ||
    location.pathname.startsWith("/chat") ||
    location.pathname.startsWith("/settings") ||
    location.pathname.startsWith("/memories/health") ||
    location.pathname.startsWith("/memories/recordings");
  const confirmations = useQuery({ queryKey: ["confirmations"], queryFn: api.confirmations });
  const pendingCount = (confirmations.data?.items ?? []).filter((item) => item.status === "pending").length;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* 顶栏：安静。没有实线分隔，层次靠留白。 */}
      <header className="hy-shell-header">
        <div className="hy-shell-brand">
          <Mark />
          <span>活页</span>
        </div>
        {/* 宽屏（≥900px，跟今天页的两栏同一断点）用顶部胶囊导航；窄屏用底部悬浮胶囊。 */}
        <nav className="hy-shell-nav" aria-label="主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                tabClass(isActive || (item.to === "/today" && location.pathname === "/"))
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button
          className="hy-shell-settings"
          onClick={() => navigate("/settings")}
          aria-label="设置"
        >
          设置
          {pendingCount > 0 ? <span className="hy-shell-badge">{pendingCount}</span> : null}
        </button>
      </header>

      <main
        className={
          isToday
            ? "hy-shell-main hy-shell-main-today flex-1 min-h-0 overflow-y-auto min-[900px]:overflow-hidden w-full"
            : "hy-shell-main flex-1 overflow-y-auto max-w-5xl w-full mx-auto pb-20"
        }
      >
        <Outlet />
      </main>

      {/* 主动消息的系统通知：页面不在前台且用户已授权时才弹。 */}
      <ProactiveNotifier />

      {/* 贴底输入：只有需要全局输入的页面才有；今天页、聊天页自带输入，不在这里再叠一层。 */}
      {hideComposer ? null : (
        <div className="hy-shell-footer shrink-0 pt-3 pb-3 min-[900px]:pb-6 min-[900px]:pt-0">
          <div className="max-w-3xl mx-auto">
            <Composer
              placeholder={placeholder}
              onSubmit={async (text) => {
                if (current?.to === "/tasks") {
                  navigate("/tasks/new", { state: { instruction: text } });
                  return;
                }
                if (current?.to === "/memories") {
                  navigate("/chat", { state: { prefill: text } });
                  return;
                }
                navigate("/chat", { state: { prefill: text, autoSend: true } });
              }}
            />
          </div>
        </div>
      )}

      {/* 窄屏底栏：悬浮胶囊 Tab，浮在内容之上，宽屏隐藏。 */}
      <nav className="hy-mobile-nav" aria-label="主导航">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              mobileTabClass(isActive || (item.to === "/today" && location.pathname === "/"))
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
