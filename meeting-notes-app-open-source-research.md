# Open-source research: AI meeting-notes app (record → transcribe+diarize → LLM summary → notes/todos)

Stars/license/activity verified via GitHub API on 2025-10-06 (all repos below actively maintained unless noted).

## 1. Meeting transcription apps / pipelines

| Project | Stars | License | Stack | Activity | Fit |
|---|---|---|---|---|---|
| [Zackriya-Solutions/meetily](https://github.com/Zackriya-Solutions/meetily) | ~31.5k | MIT | Rust + Tauri + Next.js; Whisper/Parakeet + Ollama/Claude/Groq summaries | very active | **Closest complete OSS analog to Otter/Fireflies/Voicenotes**: local capture of mic+system audio, live transcription, AI summaries, history. Desktop-first (mac/Win), not a web app. Community edition lacks some PRO features (advanced diarization/export). Fork-worthy backend patterns, not directly a web-first codebase. |
| [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | ~54.2k | MIT | C/C++ | very active | The local ASR engine everyone embeds. Has WASM/emscripten build (`examples/whisper.wasm`) → basis for in-browser transcription. |
| [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | ~25.7k | MIT | Python (CTranslate2) | active | 4× faster Whisper; default engine for self-hosted transcription services. |
| [chidiwilliams/buzz](https://github.com/chidiwilliams/buzz) | ~21.8k | MIT | Python/Qt desktop | active | Offline transcription GUI (files, live mic, speaker separation, watch-folder, CLI, plugin system incl. AI summaries). UX/reference value; not web. |
| [thewh1teagle/vibe](https://github.com/thewh1teagle/vibe) | ~7.7k | MIT | Tauri + Rust + TS | very active | File/mic/system-audio transcription, diarization, Ollama/Claude summaries, HTTP API + CLI. Great architecture reference for a small local-first recorder. |
| [m-bain/whisperX](https://github.com/m-bain/whisperX) | ~24.4k | BSD-2 | Python | active | Whisper + wav2vec2 forced alignment (word-level timestamps) + pyannote diarization. **The standard "transcribe + diarize" pipeline** to copy. |
| [pyannote/pyannote-audio](https://github.com/pyannote/pyannote-audio) | ~10.6k | MIT (code) | PyTorch | active | Speaker-diarization SOTA building blocks (SAD/SCD/overlap/embedding, `Pipeline`). **Models are gated on Hugging Face** (accept terms to download) — fine for apps, not for anonymous redistribution. |
| [modelscope/FunASR](https://github.com/modelscope/FunASR) | ~20.6k | MIT | Python | active | Alibaba ASR toolkit: Paraformer/SenseVoice + VAD + punctuation + speaker diarization, streaming + offline, OpenAI-compatible serving. **Best for Chinese/multilingual accuracy.** |
| [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | ~15.1k | Apache-2.0 | C++ (onnxruntime) | very active | On-device/streaming ASR+TTS+VAD+diarization for edge (Android/iOS/Pi/wasm). Good for future mobile. |
| [NVIDIA-NeMo/Speech](https://github.com/NVIDIA-NeMo/Speech) (formerly NVIDIA/NeMo) | ~18.6k | Apache-2.0 | Python | very active | Full speech-AI toolkit incl. Parakeet/Canary ASR + diarization (Sortformer). Powerful but heavy; use models, not the whole framework. |
| [Vexa-ai/vexa](https://github.com/Vexa-ai/vexa) | ~2.9k | Apache-2.0 | Python + Next.js dashboard | very active | **Meeting-bot approach**: bot joins Meet/Teams/Zoom, streams speaker-attributed transcript over WebSocket; MCP server. Self-host or hosted. Relevant if you prefer bot capture over local loopback. |
| [speaches-ai/speaches](https://github.com/speaches-ai/speaches) | ~3.7k | MIT | Python (faster-whisper) | active | Minimal **OpenAI-compatible transcription/serving API** (was faster-whisper-server). Ideal drop-in self-hosted STT service. |
| [QuentinFuxa/WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit) | ~11.1k | Apache-2.0 | Python (FastAPI+WS) | active | Streaming ASR server with diarization + translation, OpenAI/Deepgram-compatible API. |
| [collabora/WhisperLive](https://github.com/collabora/WhisperLive) | ~4.3k | MIT | Python | active | Near-real-time Whisper server (TensorRT/OpenVINO); browser client exists. |
| [pluja/whishper](https://github.com/pluja/whishper) | ~3.1k | AGPL-3.0 | SvelteKit + Go | active | Self-hosted web UI for transcription + subtitle editing. **AGPL — fine for personal/self-host, risky to embed in a SaaS product.** |
| [MahmoudAshraf97/whisper-diarization](https://github.com/MahmoudAshraf97/whisper-diarization) | ~5.7k | BSD-2 | Python (nb) | active | Compact Whisper+NeMo/pyannote diarization recipe; good reference implementation. |
| [kaixxx/noScribe](https://github.com/kaixxx/noScribe) | ~2.2k | GPL-3.0 | Python | active | Whisper+pyannote desktop GUI for interviews. |
| Speech Note (Linux) | ~1.7k | GPL-family | C++/Qt (KDE) | active | Linux-only offline STT/TTS notes app. |
| Transcribro (Android) | small | FOSS | Kotlin + whisper.cpp | active | On-device whisper keyboard/recorder. |
| Aiko, MacWhisper, superwhisper, Whisper Memos | n/a | **closed source** (freemium) | — | — | Popular but NOT open source — excluded from reuse; useful only as UX benchmarks. |

Curated lists for further mining: [sindresorhus/awesome-whisper](https://github.com/sindresorhus/awesome-whisper) (~2.4k★, CC0), [777genius/awesome-transcription](https://github.com/777genius/awesome-transcription), [primaprashant/awesome-voice-typing](https://github.com/primaprashant/awesome-voice-typing).

## 2. Speaker diarization

- **pyannote.audio (MIT code; gated HF models)** — the de-facto standard; pipeline = SAD → embedding clustering → overlapped-speech handling; used by WhisperX, Vibe, noScribe. Mature, well documented.
- **WhisperX (BSD-2)** — easiest "one call" diarized transcript with word-level timestamps (align + assign speakers).
- **NeMo diarization / Sortformer (Apache-2.0)** — strong alternative, more knobs; used by Meetily's backend.
- **FunASR CAM++/3D-Speaker (MIT)** — best Chinese diarization; ONNX-able via sherpa-onnx.
- Real-time streaming diarization: **diart** (~2k★) or WhisperLiveKit (diarization in streaming mode).
- Recommendation: server-side = WhisperX (or speaches + pyannote); don't attempt diarization in the browser for v1.

## 3. Browser-based audio capture

Facts (verified across MDN + production write-ups):

- **Microphone**: `getUserMedia({audio})` → `MediaRecorder` — works everywhere; Opus in WebM (Chromium) / MP4 (Safari); always detect `MediaRecorder.isTypeSupported`.
- **System/meeting audio in-browser**: `getDisplayMedia({video:true, audio:true})`:
  - Tab audio: reliable in Chromium (user ticks "share tab audio").
  - Full system audio: only Windows/ChromeOS; **macOS = tab audio only**; Firefox ≈ no audio; Safari ≈ no audio.
  - Chrome 105+ adds `systemAudio:"include"` + `suppressLocalAudioPlayback` constraints (unknown constraints are silently ignored → safe to pass everywhere).
- **Production gotchas**: listen to track `ended` (browser's "Stop sharing" bar), stop all tracks, read `getSettings().displaySurface`, audio track is "maybe" — check `getAudioTracks().length`, secure context + user gesture required.
- **Reliable system-audio paths outside pure web**: (a) virtual loopback device (BlackHole/Virtual Audio Cable) — fragile UX; (b) **desktop companion (Electron/Tauri) using `desktopCapturer` / `setDisplayMediaRequestHandler`** to supply loopback audio to the web app — the pattern used by real products; (c) meeting bot (Vexa-style).
- **Processing**: AudioWorklet for metering/VAD/silence detection; Web Audio `AudioContext` for mixing mic+tab into one track.
- **UX references**: [alyssaxuu/screenity](https://github.com/alyssaxuu/screenity) (~18.8k★, **GPL-3.0** — study, don't embed); [muaz-khan/RecordRTC](https://github.com/muaz-khan/RecordRTC) (~6.9k★, MIT, low activity since 2024 — mostly superseded by native MediaRecorder); Epicenter ([EpicenterHQ/epicenter](https://github.com/EpicenterHQ/epicenter), formerly braden-w/whispering) — web-first recorder app to copy patterns from.

## 4. Local-first storage + in-browser LLM options

| Project | Stars | License | Role |
|---|---|---|---|
| [dexie/Dexie.js](https://github.com/dexie/Dexie.js) | ~14.6k | Apache-2.0 | Minimal IndexedDB wrapper: schema versioning, transactions, `liveQuery` reactivity. Optional Dexie Cloud sync. |
| [electric-sql/pglite](https://github.com/electric-sql/pglite) | ~16.1k | Apache-2.0 | Full Postgres 16 in WASM (3 MB); pgvector; reactive bindings. |
| [electric-sql/electric](https://github.com/electric-sql/electric) | ~10.4k | Apache-2.0 | Postgres→client sync engine ("Shapes", HTTP/SSE, 1.0 Mar-2025). Read-path sync; writes via your API. |
| [powersync-ja/powersync-js](https://github.com/powersync-ja/powersync-js) | ~0.7k | Apache-2.0 SDK; **service is FSL (source-available)** | Bi-directional SQLite sync (Postgres/Mongo/MySQL); great with Supabase; multi-platform SDKs. |
| [automerge/automerge](https://github.com/automerge/automerge) | ~6.6k | MIT | Document-level CRDT (local-first conflict resolution). |
| [yjs/yjs](https://github.com/yjs/yjs) | ~22.9k | MIT | Block/text CRDT; the collaboration layer under tiptap/BlockNote/etc. |
| [rhashimoto/wa-sqlite](https://github.com/rhashimoto/wa-sqlite) | ~1.4k | MIT | SQLite WASM w/ pluggable browser VFS (OPFS, IndexedDB). Powers PowerSync web. |
| [huggingface/transformers.js](https://github.com/huggingface/transformers.js) | ~16.3k | Apache-2.0 | In-browser Whisper (WASM + **WebGPU**); realistic for short clips/tiny-base models, demos, privacy teaser — not full-meeting accuracy. |

Note: OPFS (worker) > IndexedDB for throughput; SQLite-WASM cold-start ~0.5 s; batch writes; keep per-user data bounded (<2 GB).

## 5. Combined "meeting notes + todos" apps — fork vs build?

- **[toeverything/AFFiNE](https://github.com/toeverything/AFFiNE)** (~73.3k★; MIT for most of repo, **separate license for `packages/backend` + `packages/common/native`**): local-first Notion+Miro with edgeless whiteboard. No recording pipeline. Too large to fork; use as editor/storage architecture reference.
- **[AppFlowy-IO/AppFlowy](https://github.com/AppFlowy-IO/AppFlowy)** (~77.2k★, **AGPL-3.0**): Notion alternative w/ local SQLite, tasks/databases. AGPL + no audio pipeline → not a fork base for a commercial web app.
- **Meetily** — closest to the full target workflow, but desktop-native; its value to a web-first app is architectural (local capture + local whisper.cpp server + pluggable LLM providers).
- **Vexa** — closest if the bot-joins-meeting model is acceptable; Apache-2.0, API-first.
- Conclusion: **no existing OSS project is a web-first meeting-notes+todos app you can fork wholesale. Build the web app; reuse the pipeline pieces above.** If desktop capture is required later, wrapping the web app in Tauri ( Meetily/Vibe pattern) is the well-trodden path.

---

## Deliverables

### (a) Shortlist worth reusing

1. **Meetily** (MIT) — full-app blueprint for meeting notes; fork for reference or desktop edition.
2. **whisper.cpp** (MIT) — local ASR engine + WASM path.
3. **faster-whisper** (MIT) — server ASR engine.
4. **WhisperX** (BSD-2) — diarized, word-timestamped pipeline recipe.
5. **pyannote.audio** (MIT code, gated models) — diarization.
6. **FunASR** (MIT) — Chinese/multilingual + integrated VAD/punct/diarize.
7. **speaches** (MIT) — self-hosted OpenAI-compatible STT service.
8. **transformers.js** (Apache-2.0) — optional in-browser transcription.
9. **Dexie.js** (Apache-2.0) + **PGlite** (Apache-2.0) — local storage.
10. **Electric** (Apache-2.0) or **PowerSync** (SDK Apache-2.0 / service FSL) — sync.
11. **Yjs** (MIT) — later, for collaborative editing.
12. **Screenity** (GPL-3.0) / **Epicenter** — recorder UX patterns (reference only for Screenity).

Avoid embedding (license conflicts for a SaaS): whishper/noScribe/Screenity (GPL/AGPL), PowerSync service without FSL acceptance.

### (b) Recommended transcription stack (web-first)

**Phase 1 (ship fast, best quality): cloud/hybrid**
- Record in browser (MediaRecorder; mic always, tab/system audio via `getDisplayMedia` where available) → upload audio to your backend → **hosted STT with diarization**: Groq/OpenAI Whisper API for cheap bulk, **Deepgram** if you want streaming + built-in diarization.
- LLM summary via BYOK (OpenAI/Claude) with structured-output schema → notes/todos.
- Pros: zero ML ops, best diarization economics; audio upload is the only moving part.

**Phase 2 (privacy/local mode, self-hostable):**
- Self-host **speaches** (OpenAI-compatible, faster-whisper) or **WhisperLiveKit** (streaming+diarization) in Docker; diarize with **WhisperX/pyannote** post-pass; summarize with **Ollama**.
- Optional in-browser teaser: transformers.js whisper tiny/base (WebGPU) for <2 min clips.

### (c) Recommended local-first storage

- **Now**: **Dexie.js** on IndexedDB. Tables: `meetings`, `segments` (speaker, ts), `notes`, `todos`; audio blobs in IndexedDB (or OPFS). `liveQuery` for reactive UI. Simplest mature option, zero backend.
- **If/when sync + SQL needed**: **PGlite** client + **Electric** sync from your Postgres (or **PowerSync** if on Supabase/mobile roadmap; mind FSL).
- **Collaborative editing later**: add **Yjs** (or Automerge) on note documents; Electric/PowerSync both play well with it.
- This trio (Dexie → PGlite+Electric → +Yjs) is the lowest-risk migration path; all Apache/MIT.
