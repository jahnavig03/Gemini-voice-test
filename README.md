# IPL 2026 Voice Bot — Gemini 2.5 Flash Native Audio

This repo is a **test harness for end-to-end voice** using Google’s **Live (bidirectional) API** with the native-audio model:

**`gemini-2.5-flash-native-audio-preview-12-2025`** (override with `GEMINI_LIVE_MODEL` in `.env`).

The primary experience is **tap the mic → WebSocket → Gemini Live**: one session handles listening, reasoning, and spoken replies without a separate STT/TTS chain.

---

## Architecture (current)

### 1) Live voice (primary) — `/live` WebSocket

```
Browser (public/index.html)
  │  getUserMedia → AudioWorklet → 16 kHz mono PCM (base64 JSON frames)
  ▼
Node (src/server.ts)  WebSocket path /live
  │  Forwards audio via GeminiLiveService
  ▼
Google Gemini Live API (src/gemini-live.ts)
  · @google/genai · apiVersion v1alpha
  · Model: GEMINI_LIVE_MODEL (default: gemini-2.5-flash-native-audio-preview-12-2025)
  · responseModalities: AUDIO
  · inputAudioTranscription **off by default** (set `GEMINI_LIVE_INPUT_TRANSCRIPTION=1` to enable); avoids Devanagari mis-transcripts of English biasing replies. outputAudioTranscription on (languageCodes not supported on this API)
  · Server-side VAD: realtimeInputConfig.automaticActivityDetection (+ `GEMINI_LIVE_SILENCE_MS` / `GEMINI_LIVE_PREFIX_MS`)
  · Voice: GEMINI_VOICE (e.g. Puck)
  ▼
Back to browser: model audio (PCM), `bot_text` streaming (raw output STT) then final English via `englishBotTranscriptDisplay`, `user_audio_end` from server VAD (and from input STT `finished` only if `GEMINI_LIVE_INPUT_TRANSCRIPTION=1`), turn / interrupt events
```

**Live UI:** While the user is speaking, the chat shows a **three-dot bubble** only (no input transcription). **Bot reply bubbles** fill with **English text** after the assistant finishes speaking (one translation pass per turn) so Hindi/Telugu audio still reads clearly in the log.

**Bot language:** System prompt (`src/prompts.ts`) tells the model to detect language from **speech audio** and reply in the same language.

### 2) REST voice (optional) — ElevenLabs + Gemini text

```
Browser → multipart POST /api/voice/turn
  → ElevenLabs STT (Scribe) → transcript
  → Gemini 2.5 Flash chat (src/services.ts, @google/generative-ai)
  → ElevenLabs TTS → MP3
```

Used when the widget sends **recorded audio** on the non-live path (or for comparison). Requires `ELEVENLABS_API_KEY`.

### 3) REST text — `POST /api/voice/text-turn`

Typed message → **Gemini 2.5 Flash** only. Response is **JSON** `{ "reply": "...", "latencyMs": { "llm", "total" } }` — **no audio**.

---

## Project layout

```
├── public/index.html       # Chat UI, mic capture, AudioWorklet, WebSocket client
├── src/
│   ├── server.ts           # Express, static files, /live WebSocket, REST routes
│   ├── gemini-live.ts      # Live session: connect, sendAudio, callbacks
│   ├── services.ts         # Gemini chat + englishLiveCaption; ElevenLabs STT/TTS
│   ├── prompts.ts        # IPL_SYSTEM_PROMPT (shared Live + REST)
│   └── metrics.ts        # Turn logging / session reports → logs/
├── .env                    # GEMINI_API_KEY, GEMINI_LIVE_MODEL, GEMINI_VOICE, …
├── package.json
└── tsconfig.json
```

---

## Setup

```bash
npm install
cp .env.example .env   # if present; otherwise create .env from README table
```

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` | Required. [Google AI Studio](https://aistudio.google.com/app/apikey) |
| `GEMINI_LIVE_MODEL` | Default: `gemini-2.5-flash-native-audio-preview-12-2025` |
| `GEMINI_TEXT_MODEL` | Typed REST chat only; default `gemini-2.5-flash` |
| `GEMINI_VOICE` | Live prebuilt voice, e.g. `Puck`, `Charon`, `Kore` |
| `GEMINI_LIVE_SILENCE_MS` | Optional. End-of-speech silence (ms) before the model commits your turn; default **120** (min 80). Lower = snappier, more false end-of-utterance. |
| `GEMINI_LIVE_PREFIX_MS` | Optional. Speech needed before start-of-speech commits; default **12** (min 0). Lower = picks up speech sooner. |
| `GEMINI_LIVE_INPUT_TRANSCRIPTION` | Set **`1`** to enable Live **input** STT (not recommended for English—often emits Indic script for English speech and confuses reply language). Default: **off**; `user_audio_end` uses server VAD. |
| `GEMINI_LIVE_OUTPUT_TRANSCRIPTION` | Set **`0`** to disable **bot** output STT (`outputAudioTranscription`). Default: **on** (streaming transcript in chat + English normalization when the reply finishes). |
| `ELEVENLABS_API_KEY` | Optional; only for REST `/api/voice/turn` and TTS on text path |
| `PORT` | HTTP port (default `3030` in code; README examples may use 3000) |

```bash
npm run dev    # ts-node src/server.ts
# or
npm run build && npm start
```

Open the URL printed in the console (e.g. `http://localhost:3030`).

---

## API summary

| Endpoint | Role |
|----------|------|
| `WS /live` | Live native-audio session (browser mic) |
| `POST /api/voice/turn` | Upload audio → ElevenLabs STT → Gemini → ElevenLabs TTS |
| `POST /api/voice/text-turn` | JSON text → Gemini → JSON reply (no TTS) |
| `POST /api/voice/welcome` | Opening greeting for empty chat — same user-turn text as Live `greet` (`OPENING_GREET_USER_TURN` in `prompts.ts`) so voice and typed chat align |
| `DELETE /api/voice/session/:id` | Clear REST chat session + metrics flush |
| `GET /api/voice/metrics` | Latency / turn log JSON |
| `GET /health` | Basic health + model hint |

---

## What to measure (Live)

| Signal | Meaning |
|--------|---------|
| Bot reply text in chat | **Streaming** from Live `outputAudioTranscription` (raw), then replaced with **English** via `englishBotTranscriptDisplay` when the utterance finishes; does not gate audio |
| Time to first bot audio chunk | Live model TTFA |
| **Session tokens (Live)** | **Server console:** `[Live usage] …` lines when the API sends `usageMetadata`. **Markdown:** `logs/live-*.md` header *Est. session tokens* + per-turn token rows. **Append-only log:** `logs/token-usage.jsonl` (one JSON object per report save). |
| `logs/*.md` | `recordLiveTurn` summaries per session |

---

## Tuning

- **Live VAD:** env `GEMINI_LIVE_SILENCE_MS` / `GEMINI_LIVE_PREFIX_MS`, or defaults in `src/gemini-live.ts` (`realtimeInputConfig.automaticActivityDetection`).
- **Input STT:** Default **off**. Set `GEMINI_LIVE_INPUT_TRANSCRIPTION=1` only if you need input STT; it can mis-label English as Hindi script and skew responses.
- **Client uplink:** `public/index.html` AudioWorklet `_chunk` (PCM frames per WS message); smaller = lower capture→server delay, more messages/sec.
- **English bot caption model:** `gemini-2.0-flash` inside `englishBotTranscriptDisplay()` in `src/services.ts`.
- **Bot output STT:** Default on. `GEMINI_LIVE_OUTPUT_TRANSCRIPTION=0` disables it (no streaming bot transcript).

---

## Models reference

| Use | Model id (typical) |
|-----|---------------------|
| **Live native audio (goal of this project)** | `gemini-2.5-flash-native-audio-preview-12-2025` |
| REST chat + caption normalization | `gemini-2.5-flash` / `gemini-2.0-flash` as wired in `services.ts` |

Pricing and quotas follow Google AI / Gemini API documentation for each product surface.
