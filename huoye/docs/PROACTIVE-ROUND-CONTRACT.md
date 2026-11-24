# 本轮合同：活页主动找人（三人共用）

三个 worker 必须按这份合同实现，字段名、接口路径、卡片格式**必须一致**，否则合不上。

## 0. 硬约束

- 不新增顶级 Tab；不复制 Today 官方文案/图标；UI 一律中文。
- `calendar_changes` / `allowed_news` 继续诚实空态：只保存选项，文案明确说"现在还不会按这个提醒"，本轮不实现。
- 不碰密钥；secrets.json 只读，绝不打印或提交。
- 不破坏现有左右布局（今天页左栏/右栏）、笔记页、会议流程的接口。
- 主动 ≠ 自治：任何一键按钮都不能跳过"待确认"直接对外执行。
- 不改现有已有测试的断言；只允许新增测试文件或新增 it(...)。

## 1. 共享类型与卡片格式（packages/schema，worker A 建）

新增文件 `packages/schema/src/proactive.ts`，并从 `packages/schema/src/index.ts` 导出：

```ts
export const PROACTIVE_CARD_INFO = "huoye-card";

export const proactiveActionIdSchema = z.enum([
  "view_brief",        // 打开简报全文
  "regenerate_brief",  // 再整理一版（本地重生成，不对外）
  "open_confirmations",// 跳到待确认页（不自动批准）
  "view_task",         // 打开任务详情
  "resume_proactive",  // 恢复主动更新
]);
export type ProactiveActionId = z.infer<typeof proactiveActionIdSchema>;

export const proactiveActionSchema = z.object({
  id: proactiveActionIdSchema,
  label: z.string().min(1),
});
export type ProactiveAction = z.infer<typeof proactiveActionSchema>;

export const proactiveCardKindSchema = z.enum(["brief", "task_result", "confirmation", "paused"]);
export type ProactiveCardKind = z.infer<typeof proactiveCardKindSchema>;

export const proactiveCardSchema = z.object({
  kind: proactiveCardKindSchema,
  title: z.string().min(1),
  summary: z.string().default(""),
  briefPath: z.string().optional(),
  briefDate: z.string().optional(),
  briefSlot: z.enum(["morning", "evening"]).optional(),
  taskId: z.string().optional(),
  confirmationId: z.string().optional(),
  actions: z.array(proactiveActionSchema).default([]),
});
export type ProactiveCard = z.infer<typeof proactiveCardSchema>;

/** 从一条聊天消息里拆出正文与卡片。解析失败时只返回正文，绝不抛错。 */
export function parseProactiveCard(content: string): { text: string; card?: ProactiveCard };
```

### 卡片在消息正文里的写法

聊天消息 `content` = 正文 + 一个围栏代码块：

````
正文文字（1~2 句，人话）

```huoye-card
{"kind":"brief","title":"早间简报","summary":"…","briefPath":"briefs/2026-11-23-morning.md","actions":[{"id":"view_brief","label":"查看全文"}]}
```
````

- 围栏信息串固定为 `huoye-card`。
- `parseProactiveCard` 要把围栏块从正文里摘掉，正文 trim 后返回。
- 服务端写入时正文在前、卡片块在后；正文本身要短（通知正文更短）。

## 2. 服务端（worker A）

### 2.1 状态文件

`<workspace.paths.data>/proactive-state.json`：

```ts
interface ProactiveState {
  pushedAnchors: Record<string, string>; // "2026-11-23|morning" -> ISO 时间
  unreadSince: string | null;            // 上次已读时间；null 表示已读
  paused: boolean;                        // 连续 3 天没读就暂停
  pausedAt: string | null;
  pauseNoticeAt: string | null;           // 暂停说明是否已经留在聊天里
  lastReadAt: string | null;
  notifications: Array<{ id: string; title: string; body: string; at: string; kind: string }>;
}
```

- 读取要容错（文件不存在/坏了 → 返回默认状态，不抛错）。
- 通知 `body` 一律截断到 ≤ 60 字。

### 2.2 主对话

- `ensureProactiveChat(workspace, timezone)`：**取最近更新的那个对话**（`listChats` 已按 `updated_at DESC` 排序，取第一个）；一个都没有时用 `createChat(db, "主动消息", timezone)` 新建一个。
- 写入用 `records.addMessage(db, { chatId, role: "assistant", content }, timezone)`，并 `touchChat` 让它继续排在最近。

### 2.3 主动推送函数（apps/server/src/proactive.ts，worker A 新建）

```ts
export const PROACTIVE_PAUSE_AFTER_DAYS = 3;

export function readProactiveState(workspace: Workspace): ProactiveState;
export function writeProactiveState(workspace: Workspace, state: ProactiveState): void;
export function ensureProactiveChat(workspace: Workspace, timezone: string): Chat;

/** 到点简报 → 聊天里一条助理消息（卡片 kind="brief"）。同一���同一锚点只推一次。 */
export function pushBriefToChat(
  workspace: Workspace,
  brief: { text: string; path?: string; slot: "morning" | "evening"; label: string; nextAnchor?: { label: string } },
  now: Date,
  timezone: string,
): { pushed: boolean; reason?: "duplicate" | "paused" | "off" };

/** 定时任务跑完 → 回写同一主对话（卡片 kind="task_result"）。 */
export function pushTaskResultToChat(
  workspace: Workspace,
  input: { title: string; ok: boolean; summary: string; taskId: string; chatId?: string },
  now: Date,
  timezone: string,
): { pushed: boolean };

/** 新的待确认请求 → 聊天里一条可点提醒（卡片 kind="confirmation"），仍需用户确认。 */
export function notifyPendingConfirmation(
  workspace: Workspace,
  request: { id: string; summary: string; action?: string; chatId?: string },
  now: Date,
  timezone: string,
): { pushed: boolean };

/** 用户打开/已读：清掉未读起点，记录已读时间。 */
export function markProactiveRead(workspace: Workspace, now: Date): ProactiveState;

/** 一点恢复：取消暂停，清掉未读起点。不发消息。 */
export function resumeProactive(workspace: Workspace, now: Date): ProactiveState;

export function pendingNotifications(workspace: Workspace): ProactiveState["notifications"];
export function acknowledgeNotifications(workspace: Workspace): void;
```

规则：

1. `proactivity === "off"`：**不生成简报、不写聊天、不发通知**（真正安静）。
2. `paused === true`：不再推新内容（简报卡片、任务结果、确认提醒都跳过），但暂停说明那条消息要能留下。
3. 去重键：`${dateInZone(now, tz)}|${slot}`；已推过就不再推（`pushedAnchors`）。
4. 暂停判定：推送前如果 `unreadSince` 存在，且 `unreadSince` 所在日期与今天相差 **≥ 3 天**（按 `dateInZone` 的日期差算），则置 `paused = true`，`pausedAt = now`，并在聊天里留一条说明（卡片 kind="paused"，actions 含 `resume_proactive`，文案用「主动更新已暂停」意思的中文，不要抄 Today 原句），然后跳过本次推送。同一份暂停说明只留一次（`pauseNoticeAt`）。
5. 推送成功时：若 `unreadSince === null` 则置为 now；记一条通知 `{ id, title, body(≤60字), at, kind }`；把对应去重键写进 `pushedAnchors`。
6. 简报卡片 actions：`view_brief`（查看全文）、`regenerate_brief`（再整理一版）；如果当前有 pending 待确认，再加 `open_confirmations`（去确认）。
7. 任务结果卡片 actions：`view_task`。失败也要写回，写「没能跑完 + 原因」。
8. 确认提醒卡片 actions：`open_confirmations`；正文写明「等你确认后才执行」。

### 2.4 接线点

- `apps/server/src/scheduler.ts`：`dueAnchorSlot` 之后，生成简报成功后调 `pushBriefToChat`；返回里加上 `briefPushed?: boolean`。**`off` 时不生成也不推**；`paused` 时不生成新简报（`dueAnchorSlot` 需要知道 paused：在 scheduler 里先读状态，paused 直接跳过简报生成）。
- `apps/server/src/run-task.ts`：`executeTaskRun` 结束时，若 `trigger === "schedule"`，调 `pushTaskResultToChat`（用 task.chatId 有则用其对话，否则主对话）。失败也要写回。
- `apps/server/src/workspace.ts`：`writeSettings` 里，当 `patch.onboardingCompleted === true` 且当前 `onboardingCompleted !== true` 且 patch 里**没有** `proactivity` 时，把 `proactivity` 置为 `"anchors_only"`。已有工作区/已有选择不被覆盖（不改 `off`）。
- `apps/server/src/app.ts`：新增路由
  - `GET /api/proactive/state` → `{ proactivity, paused, pausedAt, unreadSince, lastReadAt, pendingConfirmations }`
  - `POST /api/proactive/read` → `{ ok: true, state }`
  - `POST /api/proactive/resume` → `{ ok: true, state }`
  - `GET /api/proactive/notifications` → `{ items: [...] }`
  - `POST /api/proactive/notifications/ack` → `{ ok: true }`
  - `/api/confirmations` POST（新建确认）后，若该确认没有 `chatId`，调 `notifyPendingConfirmation`。
- `apps/server/src/meetings.ts`：`requestMeetingTodoConfirmations` 里新建确认后，若没有 chatId，调 `notifyPendingConfirmation`。注意：`meetings.ts` 现在被 app.ts 调用，确认是"会议待办建任务"，仍要等用户确认才建任务。

### 2.5 服务端测试（worker A）

新增 `apps/server/src/proactive.test.ts`（**不要改 app.test.ts 里的已有 it**），用冻结时钟（构造固定 `now`，传给 `tickDueWork`/`tickDueTasks`/函数参数）：

1. `anchors_only` 到锚点 → 既有简报文件，聊天里也有助理消息（正文含卡片围栏）。
2. `off` → 既没有简报文件，也没有聊天消息。
3. 同一锚点连跑两次 → 只推一条（聊天里只有 1 条主动消息）。
4. 定时任务跑完 → 主对话里出现任务结果消息（成功与失败各一例）。
5. 新待确认 → 聊天里出现确认提醒消息。
6. 连续 3 天没读 → 出现暂停说明，且之后不再推；`resumeProactive` 后恢复。
7. `onboardingCompleted` 从 false→true 且没传 proactivity → 变成 `anchors_only`；已存在 `off` 的工作区不被覆盖。

测试里可以用 `createApp({ home: mkdtempSync(...), now: () => fixedNow })` + `app.request(...)`，照抄 `apps/server/src/app.test.ts` 里 `tempApp` 的写法（可以自己复制一份 helper 到新文件）。

## 3. 网页端（worker B）

- `apps/web/src/lib/api.ts` 增加：
  - `proactiveState: () => request<ProactiveStateView>("/api/proactive/state")`
  - `markProactiveRead: () => request<{ ok: boolean; state: ProactiveStateView }>("/api/proactive/read", { method: "POST" })`
  - `resumeProactive: () => request<{ ok: boolean; state: ProactiveStateView }>("/api/proactive/resume", { method: "POST" })`
  - `notifications: () => request<{ items: ProactiveNotification[] }>("/api/proactive/notifications")`
  - `ackNotifications: () => request<{ ok: boolean }>("/api/proactive/notifications/ack", { method: "POST" })`
  - 并导出 `ProactiveStateView` / `ProactiveNotification` 类型（字段与 2.1/2.3 一致）。
- `apps/web/src/components/ChatPanel.tsx`：
  - 每条消息先用 `parseProactiveCard(message.content)` 拆出 `{ text, card }`；正文照旧渲染，card 渲染成一张卡片（用 `@huoye/ui` 的 `Card`/`Button`）。
  - 卡片按钮：
    - `view_brief`：在卡片下方展开简报全文（用 `api.memoryFile(card.briefPath)` 取 `content` 渲染，展开状态存在组件 state 里；取不到就提示「暂时打不开这份简报」）。
    - `regenerate_brief`：调 `api.brief()`（POST /api/today/brief）重新生成，把新正文显示在卡片里，并 `invalidateQueries(["brief"])`。**不要因此新增一条聊天消息**（同一天同一锚点只推一次）。
    - `open_confirmations`：`navigate("/settings/permissions")`。**只跳转，不代替用户批准。**
    - `view_task`：`navigate(`/tasks/${card.taskId}`)`。
    - `resume_proactive`：调 `api.resumeProactive()`，成功后提示「已恢复主动更新」，并刷新 proactive state。
  - 聊天里出现主动卡片消息时（读到卡片就当已读），调用一次 `api.markProactiveRead()`（同一会话只调一次，避免循环）。
- 新增 `apps/web/src/components/ProactiveNotifier.tsx`：每 30 秒轮询 `api.notifications()`；只有在 `document.hidden` 且 `typeof Notification !== "undefined"` 且 `Notification.permission === "granted"` 时才 `new Notification(title, { body })`（body 已由服务端截短），随后调 `api.ackNotifications()`。**不主动申请权限**（权限只在设置页用户点按钮时申请；未授权就安静跳过）。挂到 `apps/web/src/components/AppShell.tsx` 里。
- `apps/web/src/pages/SettingsPage.tsx` 的 `ProactivitySettings`：
  - 保留四档，但文案如实：`calendar_changes` / `allowed_news` 仍写「现在只保存这个选项，还不会按这个提醒」。
  - 新增一块状态卡：显示当前是否已暂停（读 `api.proactiveState()`），暂停时给「恢复主动更新」按钮（调 `api.resumeProactive()`）。
  - 新增「允许桌面通知」按钮：只在网页里可用（`typeof Notification !== "undefined"`）时显示，点击才 `Notification.requestPermission()`；未授权时显示「已拒绝，不再询问」。
  - 不要新增顶级 Tab，也不要改 `LINKS` 结构。
- 新增 `apps/web/src/lib/proactive.test.ts`（vitest，node 环境即可）覆盖纯逻辑：
  - `parseProactiveCard` 能从带围栏的消息里取出卡片，且正文不含围栏；
  - 非法 JSON 时只返回正文、不抛错；
  - 没有围栏时返回正文且 card 为 undefined。
  （若 `parseProactiveCard` 放在 `@huoye/schema`，测试放 `packages/schema/src/proactive.test.ts` 也可以，但**只能有一个人**改 `packages/schema`，由 worker A 负责；worker B 的测试就放 web 侧。）

## 4. 桌面端（worker C）

- 新增 `apps/desktop/src/notify.ts`（**纯函数，不许 import electron**）：
  ```ts
  export interface DesktopNotificationItem { id: string; title: string; body: string; at: string; kind: string }
  export function shouldNotifyDesktop(input: { focused: boolean; permission: string; items: DesktopNotificationItem[] }): boolean;
  export function desktopNotificationTitle(item: DesktopNotificationItem): string;   // 例："活页 · 早间简报"
  export function desktopNotificationBody(item: DesktopNotificationItem): string;    // 截断 ≤ 60 字
  ```
  规则：`focused === false` 且 `permission === "granted"` 且 `items.length > 0` 才通知。
- `apps/desktop/src/main.ts`：窗口创建后，每 30 秒 `fetch(`${origin}/api/proactive/notifications`)`；窗口不在前台（`BrowserWindow.getAllWindows().every(w => !w.isFocused())`）且 Notification 权限是 granted 时，用 Electron 的 `Notification` 发一条短通知，然后 `fetch(`${origin}/api/proactive/notifications/ack`, { method: "POST" })`。失败要静默忽略，不许让主进程崩。
- 新增 `apps/desktop/src/notify.test.ts` 覆盖上面三个纯函数（focused 时不通知、无权限不通知、body 截断、标题含中文）。

## 5. 验收

- `pnpm test`（vitest run）全绿；新增测试通过。
- `pnpm typecheck` 与 `pnpm lint` 不出现新增错误。
- 主动推送不新增顶级 Tab；今天页左右两栏不变。
