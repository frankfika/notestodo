# NotesToGO · Foresight UX + Nested OKR Redesign

> Research + product design for frankfika/notestodo (拾贝 / NotesToGO)
> Date: 2026-10-12 · Status: proposal for Fang review

## 0. What we learned from Google AI Edge Foresight

Sources: [9to5Google](https://9to5google.com/2026/10/06/google-ai-edge-foresight/), [The Verge](https://www.theverge.com/tech/1007985/google-ai-notetaking-app-transcribe-offline), [Pasquale Pillitteri hands-on](https://pasqualepillitteri.it/en/news/21914/google-foresight-mac-offline-meeting-transcription).

Foresight (Oct 2026, Mac Apple Silicon, free experimental) is strong because of **logic + UX**, not features alone:

| Pattern | How it works | Why it feels silky |
|---------|--------------|--------------------|
| **Scribble → Polish** | User types 2–3 word bullets during the call; app expands them into full notes using the live transcript | You never fight the transcript while listening; AI fills gaps after you mark what mattered |
| **Platform-agnostic capture** | Mic + system audio; no Zoom/Meet bot | Works for Meet, Zoom, in-person; zero meeting-host friction |
| **On-device stack** | Speech ASR + EmbeddingGemma 2 (retrieval) + Gemma 4 E4B/12B (generation); ~800MB expert models on first launch | Offline transcription; audio never leaves the Mac |
| **Live Assistance** | Detects questions / topics; surfaces citation cards from indexed local files | Context appears when you need it, not as a separate search chore |
| **Personal knowledge** | Point at folders (+ optional Drive/Calendar); chat retrieves with embeddings | Notes and Q&A share one retrieval layer |

**Gap vs 拾贝 today:** 拾贝 already has record → cloud ASR → template summary → todo extract → chat. It is **post-meeting document-first**. Foresight is **during-meeting scribble-first + local models + enrichment**. That is the UX leap we should copy.

## 1. Current product snapshot (notestodo)

- Stack: React + Vite + Dexie (IndexedDB) + Tauri 2 shell; BYOK LLM/ASR (MiniMax / Deepgram / Whisper)
- Todos: already `objective > kr > task` (3 levels) in `web/src/types.ts` + `TodosPage.tsx`
- Meetings: MediaRecorder chunks → pipeline jobs → summary + pending_review todos with transcript citations
- Strengths: local-first data, evidence quotes, template system, Today hub
- Weaknesses vs Foresight: no system-audio, no live scribble/enrich, cloud-only AI, flat 3-level OKR (not strategic→quarterly→project), meeting UI still “record then wait for document”

## 2. Product north star

**NotesToGO = Foresight-grade meeting companion × nested OKR execution system.**

One sentence: *During the meeting you only scribble; after (or live) notes polish themselves; every action lands on the right KR in a tree from 大 O down to project tasks — without making daily work feel like climbing a hierarchy.*

## 3. Nested OKR logic (your model, made precise)

You described:

> 大 O → 不同的 R → 季度的 OKR → 季度的 R 里再分每个项目的 OKR

Formal tree:

```
Strategic O          (大 O · 年度/多年)
  └─ Strategic KR    (大 R)
       └─ Quarterly O     (本季目标 · period=2026-Q4)
            └─ Quarterly KR
                 └─ Project O      (项目目标)
                      └─ Project KR
                           └─ Task   (可执行)
```

### 3.1 Data model (extend, don’t throw away)

Replace hard-coded 3-kind tree with **scoped OKR nodes**:

```ts
type OkrScope = 'strategic' | 'quarterly' | 'project'
type TodoKind = 'objective' | 'kr' | 'task'

interface Todo {
  // existing fields…
  kind: TodoKind
  parent_id: ID | null
  /** null only for free/inbox tasks */
  scope: OkrScope | null
  /** required when scope === 'quarterly', e.g. '2026-Q4' */
  period?: string
  /** optional rollup weight 0–1 for KR→O progress */
  weight?: number
}
```

**Parent rules (validated in app layer):**

| Child | Allowed parent |
|-------|----------------|
| strategic O | none |
| strategic KR | strategic O |
| quarterly O | strategic KR |
| quarterly KR | quarterly O |
| project O | quarterly KR |
| project KR | project O |
| task | any KR **or** null (Inbox) |

Migration: existing `objective` → `scope:'strategic'`; existing `kr` → `scope:'strategic'`; existing `task` unchanged. Seed one “Inbox” virtual bucket (UI only).

### 3.2 Silky daily UX (hierarchy must disappear most days)

| Mode | Who | What you see |
|------|-----|--------------|
| **Focus (default)** | Daily | Inbox + this quarter’s open Tasks (+ overdue). One-tap complete. No tree. |
| **Quarter** | Weekly planning | Current `period` Quarterly O → KRs → Project O/KR → Tasks. Collapse others. |
| **Strategy map** | Quarterly planning | Full Strategic → … tree; drag to reparent; progress bars roll up. |
| **Capture** | Anytime / after meeting | New items land in **Inbox** (`task`, `parent_id=null`). AI suggests “Attach to KR…” with one confirmation. |

**Progress roll-up:** Task done → Project KR % → Project O → Quarterly KR → … → Strategic KR. Show thin progress only on Focus when a KR is “active this week”.

**Meeting → OKR bridge:** Extracted todos stay `pending_review`. On confirm, show suggested Project KR (embedding / title similarity against open KRs). Never auto-deep-nest without a click.

## 4. Foresight-style meeting UX redesign

### 4.1 Live Meeting surface (replace “big record + wait”)

```
┌─ Live: 产品评审会 · 00:42:13 · ● REC ───────────────── ■ Stop ┐
│  [Scribble]     [Transcript ▾]     [Assist]                   │
│  ┌ shorthand bullets (primary) ─┐  ┌ optional live ASR ─────┐ │
│  │ - q4 budget??                │  │ 说话人1: …              │ │
│  │ - ship date risk             │  │ 说话人2: …              │ │
│  │ - @法务 contract             │  │                         │ │
│  └──────────────────────────────┘  └─────────────────────────┘ │
│  Assist cards (when knowledge hits): 「合同 §3.2 …」 [pin]     │
└───────────────────────────────────────────────────────────────┘
```

Primary action after stop (or mid-meeting shortcut): **Polish notes** = scribble + transcript → polished Markdown note (same spirit as Foresight enrich). Then existing template summary + todo extract can run as step 2 (optional “Deep summarize”).

### 4.2 Capability roadmap vs Foresight

| Capability | Phase | How in NotesToGO |
|------------|-------|------------------|
| Scribble pane + timestamp alignment | P0 | New `MeetingScribble` entity / note body draft during `recording` |
| Polish / Enrich | P0 | Prompt: expand bullets using transcript spans; BYOK LLM first |
| Mic + **system audio** | P0 (Tauri) | ScreenCaptureKit in Rust; web keeps mic-only with honest banner |
| Local ASR + local LLM | P1 | Tauri sidecar / MLX or whisper.cpp + local OpenAI-compatible endpoint; Settings: Cloud BYOK \| Local |
| Local embeddings + folder index | P1 | Embedding model on-device or small local server; index PDF/MD/Office |
| Live Assistance cards | P2 | Question/topic detect + retrieval cards during live |
| Drive/Calendar OAuth import | P2 | Keep .ics first; Drive later |

### 4.3 Privacy posture

Default narrative (match Foresight honesty): *Audio and transcripts stay on your machine when Local mode is on. Cloud BYOK is explicit opt-in. Usage analytics off by default.*

## 5. Information architecture updates

```
Today          Focus tasks + live/upcoming meetings + Inbox count
Meetings       List + Live / Detail (Scribble | Notes | Transcript | Audio | Chat)
OKRs           NEW: Focus | Quarter | Strategy map  (replaces flat Todos as primary)
Inbox          Meeting extracts + free tasks awaiting parent
Notes          Freeform + polished meeting notes
Templates
Settings       Cloud BYOK · Local models · Capture (mic/system) · Knowledge folders
```

Rename product surface to **NotesToGO** (repo stays notestodo / 拾贝 as legacy alias in README).

## 6. Implementation plan (code via local Codex + Claude on your Mac)

You asked: research/design here; **implementation with local Codex and Claude**.

Suggested execution order after you approve:

1. **Schema + OKR UI** — `types.ts`, Dexie migration, OKRs Focus/Quarter/Strategy pages, Inbox attach flow
2. **Live Scribble + Polish** — meeting detail rewrite; enrich prompt in `llm/prompts.ts`
3. **Tauri system audio** — capture path; fall back gracefully on web
4. **Local model settings** — point at local OpenAI-compatible / MLX endpoint; optional model download UX later
5. **Knowledge index + Live Assist** — after 1–4 feel silky

Branch: `feat/foresight-okr` on github.com/frankfika/notestodo. Local agents edit the checkout on `111deMacBook-Pro.local`; we open a PR when green.

## 7. Success criteria (dogfood)

1. In a real Zoom/Meet call on Mac: scribble 5 bullets → Polish → readable note in <30s after stop (cloud) / offline (local).
2. Create Strategic O → … → Project KR → Task in <2 minutes without reading a help doc.
3. Daily Focus never shows more than one “tree level” unless user opens Quarter/Strategy.
4. Meeting-extracted todo: one confirm click to attach suggested KR; evidence quote still jumps to transcript.

## 8. Open questions for you

1. Default period cadence: calendar quarter only, or also custom (半年)?
2. Local models: prefer **MLX / Ollama / LM Studio** as the first Local backend?
3. Keep Chinese name 拾贝 in UI, or switch chrome to NotesToGO?
