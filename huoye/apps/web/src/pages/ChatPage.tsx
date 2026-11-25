import { Button, Card } from "@huoye/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { api } from "../lib/api";
import { ChatPanel } from "../components/ChatPanel";

export function ChatPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const chats = useQuery({ queryKey: ["chats"], queryFn: api.chats });
  const state = (location.state as { prefill?: string; autoSend?: boolean } | null) ?? {};

  // 带着话进来时，把它交给面板；发完就清掉，避免重复发送。
  useEffect(() => {
    if (!state.autoSend || !state.prefill) return;
    const timer = setTimeout(() => {
      navigate(location.pathname, { replace: true, state: {} });
    }, 1500);
    return () => clearTimeout(timer);
  }, [state.autoSend, state.prefill, location.pathname, navigate]);

  return (
    <div className="pt-2 grid md:grid-cols-[220px_1fr] gap-4">
      <aside className="p-3 h-fit" style={{ borderLeft: "1px solid var(--hy-line)" }}>
        <div className="flex items-center justify-between mb-2" style={{ paddingLeft: 12 }}>
          <span className="hy-eyebrow">对话</span>
          <Button
            tone="ghost"
            className="!px-2.5 !py-1 text-sm"
            onClick={() => {
              void api.createChat("新对话").then((chat) => navigate(`/chat/${chat.id}`));
            }}
          >
            新建
          </Button>
        </div>
        <ul className="list-none p-0 m-0 space-y-1">
          {(chats.data?.items ?? []).map((chat) => (
            <li key={chat.id}>
              <Link
                to={`/chat/${chat.id}`}
                className={`hy-chat-link block px-3 py-2 no-underline text-sm ${chat.id === id ? "hy-chat-link-active" : ""}`}
              >
                {chat.title || "新对话"}
              </Link>
            </li>
          ))}
          {(chats.data?.items ?? []).length === 0 ? <p className="hy-muted text-sm px-2">还没有对话。</p> : null}
        </ul>
      </aside>
      <section>
        <ChatPanel
          chatId={id ?? null}
          onChatId={(chatId) => navigate(`/chat/${chatId}`, { replace: true })}
          placeholder={`和${settings.data?.assistantName ?? "叶"}聊聊…`}
          prefill={state.prefill}
          autoSend={state.autoSend ? state.prefill : null}
          emptyHint={`和${settings.data?.assistantName ?? "叶"}打个招呼吧。还没配置密钥时，会用内置的演示回复。要让模型来写，请到设置里填写你自己的密钥。`}
          footer={<p className="hy-faint text-xs mt-2">语音和附件入口尚未就绪。</p>}
        />
        <Card className="p-3 mt-3 text-sm hy-muted">
          要交待成一件可运行的任务，可以说出来，或去 <Link to="/tasks/new">新建</Link>。
        </Card>
      </section>
    </div>
  );
}
