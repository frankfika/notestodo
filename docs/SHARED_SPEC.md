# 拾贝 Shibei · 模块开发规约（建子 agent 用）

> 本规约是 4 个 build agent 共享的接口契约。任何对类型/路径/导出名的修改都要更新这里。

---

## 0. 必读

- 工作目录：`/Users/fangchen/Baidu/GitHub/Notes&ToDo`
- 前端工作目录：`web/`（已建好 React 18 + Vite 6 + Tailwind v4 + Dexie + Zustand 骨架）
- 已有：`docs/DESIGN.md`（架构）、`src/types.ts`（数据模型）、`src/db/db.ts`（Dexie schema）、`src/state/*`（UI 与录音 store）、`src/styles/main.css`（设计令牌 + Tailwind v4 `@import`）、`src/App.tsx`（外壳，已固定所有 page 导入路径）
- 启动：`cd web && pnpm dev`（5173 端口）
- 技术栈不要引入新依赖；如果确实需要，先写到 `## RBAC Needed` 段并说明。

---

## 2. 通用代码风格

- TypeScript strict；不要 `any`，要 `unknown` 再 narrow。
- React 函数组件，文件名 PascalCase，组件文件内导出默认组件 + 同名 typed props（如有）。
- Zustand：`useUI`（路由）、`useRecorder`（录音机）。新 store 命名 `useXxx`。
- Tailwind v4：主题 token 已通过 `var(--bg)` 等 OKLCH 变量在 `src/styles/main.css` 定义；用 Tailwind utility 即可（如 `bg-bg-raise text-text-1`）。
- 不用 emoji 作为唯一信息载体；图标用文本符号（● ▣ ▶︎ ✓ ✕ ⌘）。
- 所有"录制中"/"生成中"必须用文本+状态点，不用只有颜色。

---

## 3. 数据模型与 DB 调用

- 见 `src/types.ts`。所有实体有 `id, created_at, updated_at, deleted_at, sync_version`。
- DB 访问：`import { db } from '../db/db'`；外键级联查用 Dexie（`where().equals()` 等）。
- 监听响应式数据：`import { useLiveQuery } from 'dexie-react-hooks'`，如 `useLiveQuery(() => db.meetings.orderBy('started_at').reverse().toArray())`。
- 时间格式：所有时间戳用 `now()` 工具（`src/lib/id.ts`）生成 ISO；显示用 `fmtClock / fmtDate / fmtDateTime`。
- UUID 用 `uid()`（`src/lib/id.ts`）。

---

## 4. 路由与视图

- `useUI` store 持有当前视图名（`view`）和参数（`meetingId`, `noteId`, `todoFocusId`）。
- 切换页面用 `goToday / goMeetings / goMeeting(id) / goNotes / goNote(id) / goTodos(focusId?) / goTemplates / goSettings`。
- 命令面板：`useUI.setCmdkOpen(true)` 打开；全局快捷键 ⌘K 已在 App.tsx 绑定。

---

## 5. 必须实现的具体文件（4 个 agent 的分工）

### Agent A · 录音 + 转录 + 总结 pipeline

**文件路径（不可改动）：**
```
web/src/audio/engine.ts                 ← 实现并导出 bindRecorderEngine() + startRecorder / stopRecorder
web/src/audio/merge.ts                 ← 合并 audioChunks 为单 Blob
web/src/pipeline/jobs.ts               ← 实现并导出 resumePendingJobs()
web/src/pipeline/transcribe.ts         ← 转录编排：meeting.status 转 'processing' → 调用 asr → 落 Transcript
web/src/pipeline/summarize.ts          ← 总结 + todo 提取：单次 LLM 调用，输出 summary_md + todos + decisions
web/src/transcribe/types.ts            ← ASRProvider adapter interface
web/src/transcribe/minimax.ts          ← MiniMax ASR 适配器（asr-1.0，含 chunking + 跨片说话人换算）
web/src/transcribe/openai-whisper.ts   ← OpenAI 兼容适配器（Groq / OpenAI / Together）
web/src/transcribe/deepgram.ts         ← Deepgram /listen 适配器（含原生说话人分离）
web/src/llm/client.ts                  ← callLLM(settings, messages, opts) 支持 anthropic-compatible + openai-compatible
web/src/llm/prompts.ts                 ← renderTemplate(prompt_md, vars) + 默认 system prompt
```

**关键接口（export 必须是这些名字）：**
```ts
// src/audio/engine.ts
export function bindRecorderEngine(): void
export async function startRecorder(opts?: { title?: string }): Promise<void>
export async function stopRecorder(): Promise<string | null>  // returns meetingId

// src/pipeline/jobs.ts
export async function resumePendingJobs(): Promise<void>

// src/transcribe/types.ts
export interface AsrProvider {
  id: 'minimax' | 'openai-whisper' | 'deepgram'
  transcribe(input: { blob: Blob; mimeType: string; durationMs: number; settings: AppSettings; language?: string }): Promise<TranscriptSegment[]>
}

// src/llm/client.ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export async function callLLM(settings: AppSettings, messages: ChatMessage[], opts?: { jsonMode?: boolean; maxTokens?: number; temperature?: number }): Promise<string>
```

**MiniMax 适配器实现细节**：
- Endpoint：`<base>/v1/speech_to_text`（默认 base `https://api.minimaxi.com`）。
- 单 chunk ≤ 480s（留 20s 缓冲），超过就切。对每个 chunk 调用 `model=asr-1.0, response_format=verbose_json, timestamp_level=word, language=zh`，得到每片 `segments`（含 speaker 标签）。
- 跨片说话人合并：每片的 speaker 标签是局部的 "说话人 1/2/3"，需要映射成全局。策略：累计偏移 `chunkIdx*1000 + localSpeakerIdx` → 重命名为 "说话人 1/2/..." 顺序编号；同时为 LLM 总结保留每个独立 speaker 在仓库内的展示顺序。
- 文件大小：WebM Opus 每段一般 1-3MB，<50MB 没问题。

**Deepgram 适配器**：
- POST `https://api.deepgram.com/v1/listen?model=nova-3&language=zh&diarize=true&punctuate=true&smart_format=true`
- Authorization: Token `<API_KEY>`；body 是 raw audio bytes。
- 响应 `results.channels[0].alternatives[0].paragraphs.paragraphs[i].speaker` + `sentences[]`，把它映射成 `TranscriptSegment[]`。

**OpenAI Whisper 适配器**：
- POST `<base>/v1/audio/transcriptions` (form-data: file, model, response_format=verbose_json, timestamp_granularities=["segment"])。
- 没有说话人分离：speaker_label 全部用 "说话人 1"，UI 上会显示一个 speaker，可隐藏；transcript 里有 segments.text + segments.start + segments.end 即可。

**LLM client**：
- anthropic-compatible：POST `<base>/v1/messages`，body `{model, messages, max_tokens}`；Headers `{Authorization: Bearer <key>, Content-Type: application/json, anthropic-version: 2023-06-01}`。
- openai-compatible：POST `<base>/chat/completions`，body `{model, messages, max_tokens, temperature, response_format: {type:'json_object'}?}`。
- 当 `opts.jsonMode=true` 时，使用 json 响应：openai 用 `response_format: {type:'json_object'}`；anthropic 用 system prompt + 末尾 user 提示"仅返回合法 JSON"。

**summarize 步骤**：模板渲染 → 单次 LLM 调用（jsonMode=true），期望输出 `{summary_md: string, todos: Array<{title, assignee_hint?, due_hint?, evidence_quote?, evidence_span?: [start_ms, end_ms]?}>, decisions?: string[]}`。落库：Summary.content_md；每个 todo 创建 Todo{kind:'task', source:'meeting', meeting_id, transcript_span, status:'pending_review'}。decisions 作为 markdown 嵌入正文（也可加进纪要，prompt 提示）。如果 LLM 返回的 evidence_span 在 [0, durationMs] 范围内，落库到 Todo.transcript_span，否则丢弃。

### Agent B · 所有 UI 页面

**文件路径（不可改动）：**
```
web/src/pages/today/TodayPage.tsx
web/src/pages/meetings/MeetingsPage.tsx
web/src/pages/meeting/MeetingDetailPage.tsx
web/src/pages/notes/NotesPage.tsx
web/src/pages/notes/NoteDetailPage.tsx
web/src/pages/todos/TodosPage.tsx
web/src/pages/templates/TemplatesPage.tsx
web/src/pages/settings/SettingsPage.tsx
```

**页面规范：**

1. **TodayPage** — 默认首页。三块：
   - "今日待办"（从 `db.todos` 过滤 status open/pending_review 且 (due_date≤today 或 meeting_id 关联的会议 is 今天)）。空状态：插画 + "按 ⌘⇧R 开始第一场会议"。
   - "正在录音"（useRecorder 监听 phase==='recording' 时显示大卡片）。
   - "接下来的会议"（从日历/手动建）。MVP：如果没接日历，显示「暂无日程 — 可手动开始」。
   - 右上角 ⌘K 按钮（已自动绑定）。可实现一个"新建会议"小按钮调 `startRecorder()`。
2. **MeetingsPage** — 左列列表（日期分组，状态圆点 + 标题 + 时长），右列选中会议的 preview 卡片（点击跳 MeetingDetailPage）。列表用 `useLiveQuery`，按 `started_at` 倒序。
3. **MeetingDetailPage** — 顶部标题 + 状态 + 操作菜单（重新生成、改模板、删除）；主体三 Tab：
   - 纪要：Summary.content_md 展示为 Markdown（用 `MarkdownView` 组件，Agent B 自己写一个超简版即可：把 ## 标题、列表、**粗体** 渲染出来，不要引入 markdown 库）。
   - 待办（仅 status=pending_review 时显示）：勾选确认 → 变 open；点击 X 删除。
   - 转录：TranscriptSegment 列表显示（时间戳 + speaker_name + text）。speaker_name 是 speaker_names map 后的名字，未命名则显示原始标签。
   - 录音：`<audio controls src={audioBlobUrl} />`；blob URL 从 audioChunks 拼。
4. **NotesPage** — 笔记列表 + "新建笔记"按钮。
5. **NoteDetailPage** — Markdown 编辑器（纯 `<textarea>`+ 右侧预览即可，MVP）；工具栏"插入 todo"按钮调 `db.todos.add({kind:'task', source:'note', origin_note_id:...})`。
6. **TodosPage** — 三级视图（Objective > KR > Task）。单栏缩进，Objective 为大字组头，KR 中字，Task 可勾选。顶部"新建 Objective"按钮。
   - 拖拽跨级：MVP 不做拖拽，用快捷操作菜单（右键或 ⋯ 按钮）"移到…"。
   - Tag 编辑：Task 行内可以打开 chip 菜单添加 tag（Tag + TagBinding）。
7. **TemplatesPage** — 左列模板列表（内置只读 + 自定义），右列编辑器（textarea 输入 prompt_md，顶部输入 name/icon）。底部"用最近一次会议试运行"按钮：调 `callLLM` + `renderTemplate`，结果弹出 markdown 显示。
8. **SettingsPage** — 表单：LLM Provider/Base URL/API Key/Model（密码字段）；ASR 同上；隐私开关 + 日历 ics 列表（逗号分隔）；导出/导入按钮（导出 zip：JSON 元数据 + 音频文件；导入还原）。

**共享 UI 元素（Agent B 自建在 `web/src/components/`，按需）：MarkdownView.tsx, AudioPlayer.tsx, TodoRow.tsx, TagPicker.tsx, EmptyState.tsx, FieldRow.tsx。**

**样式原则**：所有列表页 `max-w-[640px] mx-auto`；卡片背景 `bg-bg-raise border border-line rounded-xl`；间距 4pt grid（p-3/p-4）；暗色为默认主题（main.css 已配）。

---

## 6. 不要做的事

- 不要引入 npm 依赖（除非 RBAC 已批准）。
- 不要修改 `src/types.ts` `src/state/*` `src/db/db.ts` `src/styles/main.css`。
- 不要在组件外副作用。

---

## 7. 完成定义

每个 agent 在自己的 workspace 任务里汇报：
- 修改/新增文件列表
- `pnpm typecheck` 输出（必须 0 errors）
- 任何超出规约的偏离 + 风险说明

Lead 负责 wire typecheck + 启动 dev server 截图（可选）+ 跑通主链路（开录 → 停 → 写本地 transcript 模拟 → 看纪要）。