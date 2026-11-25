import "../today.css";
import { Button } from "@huoye/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { briefTimeOfDayTitle, formatFriendlyLocalTime, localHourInZone, timeOfDayGreeting } from "@huoye/schema";
import { selectHomeTasks, taskStatusLabel } from "../lib/labels";
import { api, type BriefResponse } from "../lib/api";
import { ChatPanel } from "../components/ChatPanel";

function briefTag(brief: { label?: string; generatedAt?: string | null; slot?: string }, timeZone: string): string {
  if (brief.label) return brief.label;
  if (brief.generatedAt) {
    const at = new Date(brief.generatedAt);
    if (!Number.isNaN(at.getTime())) return briefTimeOfDayTitle(localHourInZone(at, timeZone));
  }
  return brief.slot === "evening" ? "晚间简报" : "早间简报";
}

function friendlyBriefTime(generatedAt: string, timeZone: string): string {
  const at = new Date(generatedAt);
  if (Number.isNaN(at.getTime())) return "";
  return formatFriendlyLocalTime(at, timeZone);
}

function greeting(name: string, timeZone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date()),
  );
  return `${timeOfDayGreeting(hour)}，${name}`;
}

function todayPrefix(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** 把一个时间戳换算成指定时区的那一天（YYYY-MM-DD）。 */
function dayInZone(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function dateLabel(timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
}

/** 把整篇简报收成几条要点：首页不摊开长文，只留可以一眼扫完的几条。 */
export function briefHighlights(text: string, limit = 4): string[] {
  const parts = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？；])/))
    .map((line) => line.replace(/^[\s·•\-*—]+/, "").trim())
    .filter((line) => line.length > 1);
  const picked: string[] = [];
  for (const part of parts) {
    if (picked.length >= limit) break;
    if (picked.includes(part)) continue;
    picked.push(part);
  }
  return picked;
}

/** 宽屏断点跟今天页的两栏断点一致（900px）。 */
const WIDE_QUERY = "(min-width: 900px)";

/** 宽屏两栏并排；窄屏单栏，靠分段控件切「今天一览 / 对话」。 */
function useIsWide(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(WIDE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = () => setWide(mq.matches);
    setWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

export function TodayPage() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: api.tasks });
  const latest = useQuery({ queryKey: ["brief"], queryFn: api.latestBrief });
  const cards = useQuery({ queryKey: ["today-cards"], queryFn: api.todayCards });
  const chats = useQuery({ queryKey: ["chats"], queryFn: api.chats });
  const notes = useQuery({ queryKey: ["notes", "", "all"], queryFn: () => api.notes("", "all") });
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [fullBrief, setFullBrief] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  // 窄屏一次只给一栏：今天一览 / 对话，靠分段控件切换。
  const isWide = useIsWide();
  const [pane, setPane] = useState<"overview" | "chat">("overview");
  const showOverview = isWide || pane === "overview";
  const showChat = isWide || pane === "chat";

  const tz = settings.data?.timezone ?? "Asia/Shanghai";
  const name = settings.data?.displayName || "你";
  const openTasks = selectHomeTasks(tasks.data?.items ?? [], todayPrefix(tz));
  const shown = brief ?? latest.data ?? null;
  const proactivity = settings.data?.proactivity ?? "off";
  const cardsReady = !cards.isPending;
  const briefReady = !latest.isPending;
  const tasksReady = !tasks.isPending;

  // 今天页复用最近的一段对话；没有对话时，等用户第一次开口再建。
  const latestChatId = chats.data?.items?.[0]?.id ?? null;
  useEffect(() => {
    if (!chatId && latestChatId) setChatId(latestChatId);
  }, [chatId, latestChatId]);

  const highlights = useMemo(() => briefHighlights(shown?.text ?? ""), [shown?.text]);

  const healthSummary = !cardsReady
    ? "正在打开…"
    : cards.data?.health.hasToday
      ? cards.data.health.summary || "今天已经记过一笔。"
      : "今天还没记";
  const meetingSummary = !cardsReady
    ? "正在打开…"
    : cards.data?.recordings.todayCount
      ? `今天有 ${cards.data.recordings.todayCount} 段录音`
      : cards.data?.recordings.count
        ? "有录音，还没有今天的纪要"
        : "今天还没有录音";

  // 笔记：今天写过几页，一共几页。
  const noteItems = (notes.data?.items ?? []).filter((item) => item.kind === "note");
  const todayNoteCount = noteItems.filter((item) => dayInZone(item.updatedAt, tz) === todayPrefix(tz)).length;
  const notesSummary = notes.isPending
    ? "正在打开…"
    : todayNoteCount > 0
      ? `今天写了 ${todayNoteCount} 页`
      : noteItems.length > 0
        ? `今天还没写 · 共 ${noteItems.length} 页`
        : "今天还没写";

  async function generate() {
    setBusy(true);
    setHint("");
    try {
      const result = await api.brief();
      setBrief(result);
      if (result.fallbackMessage) setHint(result.fallbackMessage);
      await client.invalidateQueries({ queryKey: ["brief"] });
      await client.invalidateQueries({ queryKey: ["usage"] });
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : "";
      setHint(message || "简报没有整理成功，请稍后再试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={showChat ? "hy-today" : "hy-today hy-today-glance"}>
      {/* 窄屏：单栏 + 胶囊分段控件（宽屏两栏并排，这段不出现）。 */}
      {isWide ? null : (
        <div className="hy-today-segments" role="tablist" aria-label="今天页分栏">
          {(
            [
              { key: "overview", label: "今天一览" },
              { key: "chat", label: "对话" },
            ] as const
          ).map((item) => {
            const active = pane === item.key;
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setPane(item.key)}
                className={active ? "hy-today-segment hy-today-segment-active" : "hy-today-segment"}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}

      {/* 左栏：只放今天要看的 */}
      {showOverview ? (
      <section className="hy-today-left">
        <header className="hy-today-intro">
          <h1 className="hy-today-greeting">{greeting(name, tz)}</h1>
          <div className="hy-today-eyebrow">{dateLabel(tz)}</div>
        </header>

        {/* 今日安排：清单，条目之间靠留白 */}
        <section className="hy-today-block">
          <div className="hy-today-head">
            <h2 className="hy-today-title">今日安排</h2>
            <Link to="/tasks/new" className="hy-btn hy-btn-quiet">
              新建一件
            </Link>
          </div>

          {!tasksReady ? (
            <p className="hy-today-empty">正在翻出今天的待办…</p>
          ) : openTasks.length === 0 ? (
            <p className="hy-today-empty">今天没有要跟进的事。右边说一声，或点「新建一件」。</p>
          ) : (
            <ul className="hy-today-tasks">
              {openTasks.slice(0, 5).map((task) => (
                <li key={task.id} className="hy-today-task">
                  <Link to={`/tasks/${task.id}`} className="no-underline">
                    <div className="hy-today-task-title">{task.title}</div>
                    <div className="hy-today-task-status">{taskStatusLabel(task.status)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 今日简报：一块玻璃卡，几条要点，全文按需展开 */}
        <section className="hy-today-block">
          <div className="hy-today-head">
            <h2 className="hy-today-title">今日简报</h2>
            <span className="hy-today-meta">
              {shown?.generatedAt
                ? `${briefTag(shown, tz)}${friendlyBriefTime(shown.generatedAt, tz) ? ` · ${friendlyBriefTime(shown.generatedAt, tz)}` : ""}`
                : "还没有整理"}
            </span>
          </div>

          <div className="hy-today-brief">
            {hint ? <p className="hy-today-hint">{hint}</p> : null}
            {!briefReady && !shown?.text ? (
              <p className="hy-today-empty">正在翻出今天的一页…</p>
            ) : shown?.text ? (
              <>
                <ul className="hy-today-points">
                  {highlights.map((point, index) => (
                    <li key={`${index}-${point.slice(0, 8)}`} className="hy-today-point">
                      {point}
                    </li>
                  ))}
                </ul>
                {fullBrief ? <div className="hy-today-brief-full">{shown.text}</div> : null}
              </>
            ) : (
              <p className="hy-today-empty">
                今天还没整理过。右边说一声，或者按「整理今日简报」，活页会照着你的档案和没做完的事写一版。
              </p>
            )}

            {/* 主行动全屏唯一：实心的永远只有一个。 */}
            <div className="hy-today-brief-actions">
              {shown?.text ? (
                <>
                  <Button tone="primary" onClick={() => setFullBrief((value) => !value)} style={{ whiteSpace: "nowrap" }}>
                    {fullBrief ? "收起全文" : "查看全文"}
                  </Button>
                  <Button tone="quiet" onClick={() => void generate()} disabled={busy} style={{ whiteSpace: "nowrap" }}>
                    {busy ? "正在整理…" : "再整理一版"}
                  </Button>
                </>
              ) : (
                <Button tone="primary" onClick={() => void generate()} disabled={busy} style={{ whiteSpace: "nowrap" }}>
                  {busy ? "正在整理…" : "整理今日简报"}
                </Button>
              )}
            </div>
            {proactivity === "anchors_only" && shown?.nextAnchor ? (
              <p className="hy-today-next">下一份会在 {shown.nextAnchor.label}。</p>
            ) : null}
          </div>
        </section>

        {/* 今天的痕迹：左栏底部安静的清单，标题一行，一条痕迹一行。 */}
        <footer className="hy-today-traces">
          <h3 className="hy-today-traces-title">今天的痕迹</h3>
          <ul className="hy-today-trace-list">
            <li className="hy-today-trace">
              <span className="hy-today-trace-label">笔记</span>
              <span className="hy-today-trace-status" title={notesSummary}>
                {notesSummary}
              </span>
              <Link to="/memories?new=1" className="hy-today-trace-link">
                写一页
              </Link>
            </li>
            <li className="hy-today-trace">
              <span className="hy-today-trace-label">健康</span>
              <span className="hy-today-trace-status" title={healthSummary}>
                {healthSummary}
              </span>
              <Link to="/memories/health" className="hy-today-trace-link">
                {cards.data?.health.hasToday ? "打开" : "记一笔"}
              </Link>
            </li>
            <li className="hy-today-trace">
              <span className="hy-today-trace-label">会议</span>
              <span className="hy-today-trace-status" title={meetingSummary}>
                {meetingSummary}
              </span>
              <Link to="/memories/recordings" className="hy-today-trace-link">
                打开
              </Link>
            </li>
          </ul>
        </footer>
      </section>
      ) : null}

      {/* 右栏：对话。今天页就能说话。
          窄屏切到「今天一览」时，把对话区收成 0 高（线程折起来），
          对话组件仍然挂着以免丢掉线程；输入胶囊一并收起，避免压住痕迹。 */}
      <section
        className="hy-today-right"
        style={showChat ? undefined : { height: 0, minHeight: 0, overflow: "hidden", padding: 0 }}
      >
        <div className="hy-today-right-head">
          <span className="hy-today-chat-title">今天</span>
          <span className="hy-today-chat-note">{settings.data?.assistantName ?? "叶"}在这里</span>
        </div>
        <ChatPanel
          chatId={chatId}
          onChatId={setChatId}
          placeholder="说一声要交待什么…"
          emptyHint={`和${settings.data?.assistantName ?? "叶"}打个招呼吧。没配置密钥时，会用内置的演示回复；要做的事、想记的笔记，直接说就行。`}
        />
      </section>
    </div>
  );
}
