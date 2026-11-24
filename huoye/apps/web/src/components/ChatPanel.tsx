import { Button, Card } from "@huoye/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { Link, useNavigate } from "react-router";
import type { ConfirmationRequest } from "@huoye/schema";
import "../chat.css";
import { api, streamChat, type StreamMemory } from "../lib/api";
import {
  defaultActionsFor,
  parseProactiveCard,
  proactiveKindLabel,
  type ProactiveAction,
  type ProactiveCard,
} from "../lib/proactive";

/** 一行看起来像「作者：余华」这样的字段行。 */
function isFieldLine(line: string): boolean {
  return /^[^：:\n]{1,10}[：:]/.test(line.trim());
}

/** 预览里不要漏出 markdown 记号。 */
function cleanMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/\*\*/g, "")
    .trim();
}

/**
 * 长文只留标题 + 一句说明，全文点进去再看。
 * 笔记、任务这类整篇铺开的内容不再是一堵字段墙。
 */
export function chatPreview(text: string): { collapsed: boolean; title: string; desc: string } {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const fieldCount = lines.filter(isFieldLine).length;
  const collapsed = text.length > 200 || (lines.length > 3 && fieldCount >= 2);
  if (!collapsed) return { collapsed: false, title: "", desc: "" };
  const free = lines.filter((line) => !isFieldLine(line));
  return { collapsed: true, title: cleanMarkdown(free[0] ?? lines[0] ?? ""), desc: cleanMarkdown(free[1] ?? "") };
}

/**
 * 对话面板：今天页右栏与聊天页共用同一套对话能力。
 * 聊天页传入路由里的 chat id；今天页自己持有最近一段对话的 id。
 */
export function ChatPanel({
  chatId,
  onChatId,
  placeholder,
  emptyHint,
  footer,
  prefill,
  autoSend,
}: {
  chatId: string | null;
  onChatId?: (id: string) => void;
  placeholder: string;
  emptyHint?: ReactNode;
  footer?: ReactNode;
  prefill?: string;
  autoSend?: string | null;
}) {
  const client = useQueryClient();
  const thread = useQuery({
    queryKey: ["messages", chatId],
    queryFn: () => api.messages(chatId!),
    enabled: Boolean(chatId),
  });
  const [draft, setDraft] = useState(prefill ?? "");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [memory, setMemory] = useState<StreamMemory | null>(null);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<ConfirmationRequest | null>(null);
  const [editText, setEditText] = useState("");
  // 展开了哪些长文（按消息 id 记）。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (prefill) setDraft(prefill);
  }, [prefill]);

  useEffect(() => {
    setMemory(null);
    setNote("");
    setEditing(null);
    setStreaming("");
  }, [chatId]);

  // 主动卡片消息：打开聊天看到就算已读。同一批卡片只上报一次，不会来回打转。
  const proactiveMessageId = useMemo(() => {
    let latest = "";
    for (const message of thread.data?.items ?? []) {
      if (parseProactiveCard(message.content).card) latest = message.id;
    }
    return latest;
  }, [thread.data]);

  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!proactiveMessageId) return;
    if (markedRef.current === proactiveMessageId) return;
    markedRef.current = proactiveMessageId;
    void api
      .markProactiveRead()
      .then(() => client.invalidateQueries({ queryKey: ["proactive-state"] }))
      .catch(() => {
        // 已读上报失败不该打断聊天。
      });
  }, [client, proactiveMessageId]);

  async function send(text: string) {
    const content = text.trim();
    if (!content) return;
    setError("");
    setBusy(true);
    setStreaming("");
    try {
      let id = chatId;
      if (!id) {
        const chat = await api.createChat("新对话");
        id = chat.id;
        onChatId?.(chat.id);
        await client.invalidateQueries({ queryKey: ["chats"] });
      }
      const result = await streamChat(id, content, (chunk) => setStreaming((prev) => prev + chunk));
      setMemory(result.memory ?? null);
      setNote("");
      setDraft("");
      setStreaming("");
      await client.invalidateQueries({ queryKey: ["messages", id] });
      await client.invalidateQueries({ queryKey: ["chats"] });
      await client.invalidateQueries({ queryKey: ["usage"] });
      await client.invalidateQueries({ queryKey: ["confirmations"] });
      await client.invalidateQueries({ queryKey: ["activities"] });
      await client.invalidateQueries({ queryKey: ["memory"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }

  // 从别的页面带着话过来时，直接替用户发出去。
  const autoSent = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSend || autoSent.current === autoSend) return;
    autoSent.current = autoSend;
    void send(autoSend);
  }, [autoSend]);

  return (
    <div className="hy-chat-panel">
      <div className="hy-chat-thread">
        {(thread.data?.items ?? []).map((message) => {
          const parsed = parseProactiveCard(message.content);
          const text = parsed.text ?? "";
          const preview = chatPreview(text);
          const showFull = message.role === "user" || !preview.collapsed || expanded[message.id] === true;
          return (
            <div
              key={message.id}
              className={`hy-chat-row ${message.role === "user" ? "hy-chat-row-user" : "hy-chat-row-assistant"}`}
            >
              <div
                className={`hy-chat-bubble text-[15px] leading-7 ${
                  message.role === "user" ? "hy-chat-bubble-user" : "hy-chat-bubble-assistant"
                }`}
              >
                {parsed.text ? (
                  showFull ? (
                    <div className="markdown-body">
                      <Markdown>{parsed.text}</Markdown>
                    </div>
                  ) : (
                    <div>
                      <div className="hy-chat-preview-title">{preview.title}</div>
                      {preview.desc ? <div className="hy-chat-preview-desc">{preview.desc}</div> : null}
                      <button
                        type="button"
                        className="hy-chat-expand"
                        onClick={() => setExpanded((prev) => ({ ...prev, [message.id]: true }))}
                      >
                        查看全文
                      </button>
                    </div>
                  )
                ) : null}
                {parsed.card ? <ProactiveCardView card={parsed.card} /> : null}
              </div>
            </div>
          );
        })}
        {streaming ? (
          <div className="hy-chat-row hy-chat-row-assistant">
            <div className="hy-chat-bubble hy-chat-bubble-assistant text-[15px] leading-7">
              <div className="markdown-body">
                <Markdown>{streaming}</Markdown>
              </div>
            </div>
          </div>
        ) : null}
        {!chatId && !busy && emptyHint ? (
          <div className="hy-muted" style={{ maxWidth: "30rem", lineHeight: 1.9, fontSize: "var(--hy-fs-md)" }}>
            {emptyHint}
          </div>
        ) : null}
        {memory?.diaryAppended ? <p className="hy-faint text-xs mt-2">已记到今天的日记。</p> : null}
        {memory?.note ? (
          <p className="hy-muted text-xs mt-2">
            已写成一页笔记：
            <Link to={memory.note.href} className="hy-link">
              {memory.note.title}
            </Link>
            <span className="hy-faint">（{memory.note.path}）</span>
          </p>
        ) : null}
        {memory?.confirmations?.map((item) => (
          <Card key={item.id} className="hy-chat-card p-3 mt-3 text-sm">
            <p className="m-0">
              {item.action === "memory.about_you.patch" ? "建议写入基本档案" : item.summary}
            </p>
            <pre className="hy-confirm-preview my-2">{item.preview}</pre>
            {item.status !== "pending" ? (
              <p className="hy-faint text-xs m-0">{item.status === "rejected" ? "已不用。" : "已接受。"}</p>
            ) : editing?.id === item.id ? (
              <div className="flex gap-2 mt-2">
                <textarea
                  className="hy-textarea text-sm"
                  rows={3}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                />
                <Button
                  onClick={() => {
                    void api.editAndApprove(item.id, editText).then((res) => {
                      setMemory((prev) =>
                        prev
                          ? {
                              ...prev,
                              confirmations: prev.confirmations.map((c) => (c.id === item.id ? res.item : c)),
                            }
                          : prev,
                      );
                      setNote(res.executed?.message ?? "");
                      setEditing(null);
                      return Promise.all([
                        client.invalidateQueries({ queryKey: ["confirmations"] }),
                        client.invalidateQueries({ queryKey: ["about-you"] }),
                        client.invalidateQueries({ queryKey: ["memory-tree"] }),
                      ]);
                    });
                  }}
                >
                  保存并接受
                </Button>
              </div>
            ) : (
              <div className="flex gap-2 mt-2">
                <Button
                  onClick={() => {
                    void api.approve(item.id).then((res) => {
                      setMemory((prev) =>
                        prev
                          ? {
                              ...prev,
                              confirmations: prev.confirmations.map((c) => (c.id === item.id ? res.item : c)),
                            }
                          : prev,
                      );
                      setNote(res.executed?.message ?? "");
                      return Promise.all([
                        client.invalidateQueries({ queryKey: ["confirmations"] }),
                        client.invalidateQueries({ queryKey: ["about-you"] }),
                        client.invalidateQueries({ queryKey: ["memory-tree"] }),
                      ]);
                    });
                  }}
                >
                  接受
                </Button>
                {item.editable ? (
                  <Button
                    tone="quiet"
                    onClick={() => {
                      setEditing(item);
                      setEditText(item.preview);
                    }}
                  >
                    编辑后接受
                  </Button>
                ) : null}
                <Button
                  tone="quiet"
                  onClick={() => {
                    void api.reject(item.id).then((res) => {
                      setMemory((prev) =>
                        prev
                          ? {
                              ...prev,
                              confirmations: prev.confirmations.map((c) => (c.id === item.id ? res.item : c)),
                            }
                          : prev,
                      );
                      return client.invalidateQueries({ queryKey: ["confirmations"] });
                    });
                  }}
                >
                  不用
                </Button>
              </div>
            )}
          </Card>
        ))}
        {note ? <p className="hy-muted text-xs mt-2">{note}</p> : null}
      </div>

      {error ? <p className="text-[var(--hy-danger)] text-sm mt-2">{error}</p> : null}

      <form
        className="hy-composer-pill"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          className="hy-input !w-auto min-w-0 flex-1 !border-0 !shadow-none !bg-transparent !px-2 !py-1 resize-none"
          rows={1}
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <Button type="submit" className="shrink-0 whitespace-nowrap self-end" disabled={busy || !draft.trim()} aria-label="发送">
          {busy ? "…" : "发送"}
        </Button>
      </form>
      {footer}
    </div>
  );
}

/**
 * 主动消息卡片：短要点 + 几个按钮。
 * 按钮只做三件事——打开全文、再生成一次、跳到该去的页面；
 * 绝不替用户批准确认，也不跳过确认直接对外执行。
 */
function ProactiveCardView({ card }: { card: ProactiveCard }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [regenerated, setRegenerated] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const briefFile = useQuery({
    queryKey: ["brief-file", card.briefPath],
    queryFn: () => api.memoryFile(card.briefPath!),
    enabled: open && Boolean(card.briefPath) && regenerated === null,
  });

  const regenerate = useMutation({
    mutationFn: () => api.brief(),
    onSuccess: async (result) => {
      setRegenerated(result.text ?? "");
      setOpen(true);
      setNote("已经重新整理了一版，没有再往聊天里多发一条。");
      await client.invalidateQueries({ queryKey: ["brief"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "这次没有整理成功。"),
  });

  const resume = useMutation({
    mutationFn: () => api.resumeProactive(),
    onSuccess: async () => {
      setNote("已恢复主动更新。");
      await client.invalidateQueries({ queryKey: ["proactive-state"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "暂时恢复不了主动更新。"),
  });

  function run(action: ProactiveAction) {
    setError("");
    switch (action.id) {
      case "view_brief":
        if (!card.briefPath) {
          setError("这份简报没有留下全文的路径。");
          return;
        }
        setOpen((value) => !value);
        return;
      case "regenerate_brief":
        // 本地再整理一版，不对外发任何东西，也不新增聊天消息。
        regenerate.mutate();
        return;
      case "open_confirmations":
        // 只跳到待确认页：批不批由用户自己决定。
        navigate("/settings/permissions");
        return;
      case "view_task":
        if (!card.taskId) {
          setError("这条结果没有标出是哪件任务。");
          return;
        }
        navigate(`/tasks/${card.taskId}`);
        return;
      case "resume_proactive":
        resume.mutate();
        return;
      default:
        return;
    }
  }

  const actions = card.actions.length > 0 ? card.actions : defaultActionsFor(card);

  return (
    <Card className="hy-chat-card p-3 mt-3">
      <div className="hy-eyebrow">{proactiveKindLabel(card.kind)}</div>
      <div className="font-medium mt-1">{card.title}</div>
      {card.summary ? (
        <p className="hy-muted text-sm mt-1" style={{ lineHeight: 1.8, whiteSpace: "pre-wrap" }}>
          {card.summary}
        </p>
      ) : null}
      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-2 mt-3">
          {actions.map((action) => (
            <Button
              key={action.id}
              tone="quiet"
              className="!py-1"
              onClick={() => run(action)}
              disabled={regenerate.isPending || resume.isPending}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
      {note ? <p className="hy-faint text-xs mt-2">{note}</p> : null}
      {error ? <p className="text-sm text-[var(--hy-danger)] mt-2">{error}</p> : null}
      {open ? (
        <div className="mt-3">
          {regenerated !== null ? (
            <div className="markdown-body">
              <Markdown>{regenerated}</Markdown>
            </div>
          ) : briefFile.isPending ? (
            <p className="hy-muted text-sm">正在取这份简报…</p>
          ) : briefFile.isError ? (
            <p className="text-sm text-[var(--hy-danger)]">暂时打不开这份简报。</p>
          ) : briefFile.data ? (
            <div className="markdown-body">
              <Markdown>{briefFile.data.content}</Markdown>
            </div>
          ) : (
            <p className="hy-muted text-sm">暂时打不开这份简报。</p>
          )}
        </div>
      ) : null}
    </Card>
  );
}
