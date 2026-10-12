# Codex · Phase-3 owner brief — NotesToGO hard gaps (feat/foresight-okr)

Repo: `/Users/fangchen/Projects/notestodo` · Branch: `feat/foresight-okr`  
HEAD baseline: `6e0deb5` (Phase-2 done: system-audio *stubs* + Local LLM + knowledge keyword MVP + README).  
You are the **sole Phase-3 implementer**. Do **not** push. Commit on `feat/foresight-okr` in logical commits. Do **not** break Phase-1 OKR / Scribble / light theme or Phase-2 Settings Cloud|Local / Assist tab.

Fang: finish the **remaining hard gaps** that Phase-2 left as honest TODOs / HTTP-only MVP.

---

## Read first (in order)

1. This brief (acceptance criteria below are binding)
2. `docs/FORESIGHT_OKR_REDESIGN.md` — §4.2 roadmap (system audio / local ASR / knowledge)
3. `docs/CLAUDE_TASK_PHASE2.md` — what Phase-2 already shipped vs deferred
4. `README.md` — Phase-2 capability notes (update when you close gaps)
5. Code (paths relative to repo root; app lives under `web/`):
   - `web/src-tauri/` — **actual Tauri path** (`Cargo.toml`, `Info.plist`, `src/lib.rs`, `capabilities/`)
   - `web/src/lib/tauri.ts`, `tauriInvoke.ts`, `tauriSystemAudio.ts`
   - `web/src/audio/engine.ts`, `web/src/components/RecordingBar.tsx`
   - `web/src/lib/knowledge.ts` — HTTP(S)-only reindex today; keep `retrieveKnowledge()` stable
   - `web/src/pages/settings/SettingsPage.tsx`, `web/src/types.ts`, `web/src/db/*`
   - `web/src/llm/*`, `web/src/transcribe/*` — ASR client path

---

## Constraints

- Work only on branch `feat/foresight-okr`. **Never `git push`.**
- Logical commits (suggested split below). Message style: `feat:` / `docs:` / `fix:` / `chore:`.
- Web path (browser, no Tauri) **must keep working**: mic-only + honest banner; knowledge HTTP(S) paths still work; no hard Rust dependency at runtime in the browser.
- Prefer proper `@tauri-apps/api` install over the `new Function('import')` hack in `tauriInvoke.ts` — keep web build green (tree-shake / conditional).
- Typecheck + existing e2e must stay green. Prefer `web/node_modules/.bin/tsc` / `vite` / playwright if `pnpm exec` hits install-script blocks.
- Do not rip out MiniMax / Deepgram / cloud BYOK / Ollama Local LLM paths.
- macOS Screen Recording: ship working capture code + plist; document that **Fang must grant** in System Settings. Degrade to mic-only + banner if denied.
- Do **not** touch unrelated dirty files (e.g. `web/tests/screenshots/*.png` unless your e2e regenerates them intentionally; leave untracked Phase-2 docs alone unless you need to reference them).
- Leave any interactive Claude / MiniMax GUI sessions alone.

---

## Gap 1 — Real ScreenCaptureKit system audio (HARD)

### Current state
`web/src-tauri/src/lib.rs` has command surface (`system_audio_status` / `_start` / `_stop`) but all return `supported: false` / `not_implemented` with `TODO(system-audio)`. Info.plist already has `NSScreenCaptureUsageDescription`. Frontend already has `tauriSystemAudio.ts` + honest banner.

### Goal
Replace stubs with a **working** macOS ScreenCaptureKit (or equivalent) capture path that can provide system audio alongside mic when entitlements allow.

### Implement
1. Add a macos-only dependency (e.g. `screencapturekit` crate ~0.11 / or `cidre` / objc bridge — pick what compiles cleanly on Apple Silicon + Tauri 2). Guard with `#[cfg(target_os = "macos")]`.
2. Wire real:
   - `system_audio_status` → `supported: cfg!(macos)`, probe TCC / shareable content; set `permission_granted` honestly; clear `note`.
   - `system_audio_start` → start SCStream with **audio capture** (display/app audio loopback for meeting playback). Prefer audio-only if the crate allows (no need to encode video frames).
   - `system_audio_stop` → stop + cleanup.
3. Deliver PCM/chunks to the frontend in one of these pragmatic ways (pick best that works):
   - **A (preferred):** emit Tauri events with base64/PCM f32 chunks; TS side mixes into `audio/engine.ts` via AudioContext / MediaStreamDestination alongside mic MediaRecorder pipeline.
   - **B:** write a temp WAV/CAF chunk file path and let TS read via fs plugin.
   - **C:** if full duplex mix in-process is too heavy in one pass: start/stop + status working + documented file/PCM path + TS glue that at least records system audio into the meeting audio store; mic remains primary. **Never** fake “system audio on” in UI.
4. Update `capabilities/` if new permissions / events needed.
5. Keep web fallback: `isTauri()` false → mic-only + existing banner copy.
6. README: explicit step — Fang must approve **系统设置 → 隐私与安全性 → 屏幕录制 → NotesToGO**.

### Acceptance
- [ ] On macOS Tauri build, `system_audio_status.supported == true` when code path exists (permission may still be false until Fang clicks).
- [ ] Start/stop no longer return only `not_implemented`.
- [ ] Denied / unavailable → mic-only + honest banner (never silent pretend).
- [ ] `TODO(system-audio)` stubs removed or reduced to polish-only notes.
- [ ] Web path unchanged.

---

## Gap 2 — Tauri local filesystem for knowledge folders

### Current state
`reindexKnowledge()` only `fetch()`es HTTP(S) `.md/.txt` URLs. Local folder paths silently index nothing. Comments already point at `tauri-plugin-fs`.

### Goal
In Tauri, reindex **real local paths** (directories + files). Keep `retrieveKnowledge(query, entries, limit?)` API stable for Assist / callers.

### Implement
1. Add `tauri-plugin-fs` (and `tauri-plugin-dialog` if not present for folder picker). Register in `lib.rs` + capabilities (read scope: user-selected dirs; use dialog-picked paths / allowlist pattern Tauri 2 recommends — do **not** grant unrestricted FS without scope).
2. TS: when `isTauri()`, walk folder for `.md` / `.txt` (and PDF if Gap 3 lands), read text via plugin, write `knowledgeEntries` as today.
3. Web: keep HTTP(S) / single-file URL behavior; show clear Settings hint that real folders need desktop app.
4. Settings Knowledge UI: in Tauri, prefer folder picker; still allow paste path.

### Acceptance
- [ ] Tauri: add a local folder with `.md` → Reindex → Assist can retrieve.
- [ ] `retrieveKnowledge` signature/behavior stable.
- [ ] Web does not crash on local path paste (skip + error string ok).

---

## Gap 3 — PDF indexing if feasible

### Goal
If feasible without boiling the ocean: index PDF text into the same `knowledgeEntries` store.

### Implement
- Prefer existing lightweight approach: `pdfjs-dist` in TS after reading bytes from fs/fetch, or a small Rust pdf extract if cleaner.
- Cap pages / chars (reuse `FULLTEXT_CAP`).
- Skip scanned/image-only PDFs gracefully (empty text → skip, no crash).
- If too heavy after a solid attempt: document in README as deferred and ship Gaps 1–2/4–5 green — but **try**.

### Acceptance
- [ ] At least one PDF with extractable text indexes into Assist, **or** README explicitly marks PDF deferred with reason after a real attempt.

---

## Gap 4 — Local ASR path (Settings + client)

### Goal
Mirror Local LLM: Settings + client path for **local OpenAI-compatible STT** (whisper.cpp server / MLX / faster-whisper openai-compatible). Full whisper binary sidecar is optional if too heavy — **OpenAI-compatible local STT base URL + clear UI is enough**.

### Implement
1. Extend `AppSettings` (Dexie migration as needed), e.g.:
   - `asr_mode: 'cloud' | 'local'` **or** reuse pattern from `ai_mode` / local LLM fields:
   - `local_asr_base_url` (default e.g. `http://127.0.0.1:8080/v1` or whisper.cpp default)
   - `local_asr_api_key` (optional empty)
   - `local_asr_model` (e.g. `whisper-1` / local model name)
   - Preserve cloud `asr_*` when toggling.
2. Settings UI: Cloud | Local for ASR (near existing ASR section), presets + Test connection.
3. Transcribe client (`web/src/transcribe/*` + pipeline): when local mode, POST to `{base}/audio/transcriptions` (OpenAI-compatible) with empty key → omit Authorization.
4. Relax `testASRConnection` for local empty key (same as Local LLM).
5. README note: how to run whisper.cpp server / MLX STT / faster-whisper openai API.

### Acceptance
- [ ] User can switch ASR Cloud ↔ Local without wiping the other side.
- [ ] Local empty key works; test connection hits local `/models` or transcriptions health.
- [ ] Pipeline uses local endpoint when mode=local.

---

## Gap 5 — Install/wire `@tauri-apps/api` properly

### Current state
Only `@tauri-apps/cli` in package.json. `tauriInvoke.ts` uses `new Function` dynamic import hack.

### Goal
`pnpm add @tauri-apps/api` (matching Tauri 2.x) in `web/`; replace hack with normal `import { invoke } from '@tauri-apps/api/core'` (or thin wrapper that still no-ops safely when `!isTauri()`). Ensure Vite build does not break for pure web.

### Acceptance
- [ ] `@tauri-apps/api` in dependencies.
- [ ] No `new Function('import')` hack required (or only as last-resort fallback with comment).
- [ ] `tsc` + `vite build` green on web.

---

## Gap 6 — Verify: typecheck / build / Playwright e2e

From `web/`:
1. `node_modules/.bin/tsc -b --noEmit` (or `pnpm typecheck` if it works)
2. `node_modules/.bin/vite build` (or `pnpm build`)
3. Playwright e2e (existing suite under `web/tests` — use project’s usual command, e.g. `pnpm exec playwright test` or `npx playwright test`). Fix regressions you introduce.
4. Add/adjust light tests if feasible: Settings Local ASR toggle smoke; knowledge reindex does not crash; Assist tab still present. Don’t block on Tauri-only native tests in CI/web.

---

## Suggested commit split

1. `feat: wire @tauri-apps/api + clean invoke helper`
2. `feat: ScreenCaptureKit system-audio capture path (macOS)`
3. `feat: tauri-plugin-fs knowledge folder reindex (+ PDF if landed)`
4. `feat: Local ASR settings + OpenAI-compatible STT client path`
5. `docs: Phase-3 README — Screen Recording grant, local STT, FS knowledge`
6. `test:` / `fix:` as needed for e2e/typecheck

Adjust if a cleaner split appears; keep commits reviewable. **Do not push.**

---

## Out of scope

- Full EmbeddingGemma / vector DB
- Drive/Calendar OAuth
- Rewriting Phase-1 OKR / Scribble UX / light theme
- Publishing DMG / notarization
- `git push` / opening PR
- Bundling multi-hundred-MB whisper weights into the app (point at local server instead)

---

## Done means

1. Gaps 1–5 addressed per acceptance (Gap 3: ship or documented defer after attempt).
2. Logical commits on `feat/foresight-okr`, **not pushed**.
3. typecheck + vite build + Playwright e2e green (report counts).
4. Final reply listing:
   - commit SHAs + one-line each
   - test results (tsc / build / e2e pass counts)
   - remaining blockers — especially **Screen Recording** entitlement Fang must click in System Settings
   - what was deferred (if anything) and why

Start now. Prefer working incremental commits over one giant opaque diff.
