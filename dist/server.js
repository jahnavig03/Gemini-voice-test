"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
require("dotenv/config");
const http_1 = require("http");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const multer_1 = __importDefault(require("multer"));
const ws_1 = require("ws");
const services_1 = require("./services");
const gemini_live_1 = require("./gemini-live");
const prompts_1 = require("./prompts");
const metrics_1 = require("./metrics");
// ── App bootstrap ─────────────────────────────────────────────────
const app = (0, express_1.default)();
const PORT = process.env.PORT ?? 3030;
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.static(path_1.default.join(__dirname, "../public")));
// ── Services ──────────────────────────────────────────────────────
const gemini = new services_1.GeminiService();
const eleven = new services_1.ElevenLabsService();
const liveService = new gemini_live_1.GeminiLiveService();
const sessionTurnCount = {};
// ── REST: voice turn (ElevenLabs STT → Gemini → ElevenLabs TTS) ──
app.post("/api/voice/turn", upload.single("audio"), async (req, res) => {
    const sessionId = req.body.sessionId || `session_${Date.now()}`;
    if (!req.file) {
        res.status(400).json({ error: "No audio file." });
        return;
    }
    sessionTurnCount[sessionId] = (sessionTurnCount[sessionId] ?? 0) + 1;
    const turnIndex = sessionTurnCount[sessionId];
    try {
        const t0 = Date.now();
        const t1 = Date.now();
        const transcript = await eleven.transcribe(req.file.buffer, req.file.mimetype);
        const stt_ms = Date.now() - t1;
        if (!transcript.trim()) {
            res.status(200).json({ error: "Could not transcribe." });
            return;
        }
        const t2 = Date.now();
        const reply = await gemini.chat(sessionId, transcript);
        const llm_ms = Date.now() - t2;
        const t3 = Date.now();
        const audio = await eleven.synthesize(reply);
        const tts_ms = Date.now() - t3;
        const total_ms = Date.now() - t0;
        const { score, note } = (0, metrics_1.computeResponseQuality)(reply);
        (0, metrics_1.recordTurn)({
            sessionId, turnIndex, inputMode: "voice",
            timestamp: new Date().toISOString(),
            transcript, geminiResponse: reply,
            latency: { stt_ms, llm_ms, tts_ms, total_ms },
            transcriptWordCount: transcript.trim().split(/\s+/).filter(Boolean).length,
            responseWordCount: reply.trim().split(/\s+/).filter(Boolean).length,
            transcriptAccuracyNote: (0, metrics_1.computeTranscriptAccuracy)("voice", transcript),
            responseQualityScore: score, responseQualityNote: note,
        });
        res.set({
            "Content-Type": "audio/mpeg",
            "X-Transcript": encodeURIComponent(transcript),
            "X-Reply-Text": encodeURIComponent(reply),
            "X-Latency-STT": String(stt_ms),
            "X-Latency-LLM": String(llm_ms),
            "X-Latency-TTS": String(tts_ms),
            "X-Latency-Total": String(total_ms),
        });
        res.send(audio);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ── REST: text turn (Gemini only — text reply, no TTS) ───────────
app.post("/api/voice/text-turn", async (req, res) => {
    const { text, sessionId = `session_${Date.now()}` } = req.body;
    if (!text?.trim()) {
        res.status(400).json({ error: "text required." });
        return;
    }
    sessionTurnCount[sessionId] = (sessionTurnCount[sessionId] ?? 0) + 1;
    const turnIndex = sessionTurnCount[sessionId];
    try {
        const t0 = Date.now();
        const t2 = Date.now();
        const reply = await gemini.chat(sessionId, text);
        const llm_ms = Date.now() - t2;
        const total_ms = Date.now() - t0;
        const { score, note } = (0, metrics_1.computeResponseQuality)(reply);
        (0, metrics_1.recordTurn)({
            sessionId, turnIndex, inputMode: "text",
            timestamp: new Date().toISOString(),
            transcript: text, geminiResponse: reply,
            latency: { stt_ms: 0, llm_ms, tts_ms: 0, total_ms },
            transcriptWordCount: text.trim().split(/\s+/).filter(Boolean).length,
            responseWordCount: reply.trim().split(/\s+/).filter(Boolean).length,
            transcriptAccuracyNote: (0, metrics_1.computeTranscriptAccuracy)("text", text),
            responseQualityScore: score, responseQualityNote: note,
        });
        res.json({
            reply,
            latencyMs: { llm: llm_ms, total: total_ms },
        });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ── REST: natural opening welcome (does not log a turn or touch chat history) ──
app.post("/api/voice/welcome", async (_req, res) => {
    try {
        const message = await gemini.welcomeChatOpening();
        res.json({ message });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// ── REST: session management ──────────────────────────────────────
app.delete("/api/voice/session/:id", (req, res) => {
    const { id } = req.params;
    (0, metrics_1.saveSessionReport)(id);
    gemini.clearSession(id);
    delete sessionTurnCount[id];
    res.json({ ok: true });
});
app.get("/api/voice/metrics", (_req, res) => {
    res.json({ summary: (0, metrics_1.getSummary)(), turns: (0, metrics_1.getMetrics)() });
});
app.get("/health", (_req, res) => {
    res.json({ status: "ok", model: process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-preview-native-audio-dialog" });
});
app.get("*", (_req, res) => {
    res.sendFile(path_1.default.join(__dirname, "../public/index.html"));
});
// ── HTTP + WebSocket server ───────────────────────────────────────
const httpServer = (0, http_1.createServer)(app);
const wss = new ws_1.WebSocketServer({ server: httpServer, path: "/live" });
wss.on("connection", (ws) => {
    let state = null;
    const send = (obj) => {
        if (ws.readyState === ws_1.WebSocket.OPEN)
            ws.send(JSON.stringify(obj));
    };
    ws.on("message", async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        switch (msg.type) {
            // ── Init: open Gemini Live session ──────────────────────────
            case "init": {
                if (state)
                    state.session.close(); // replace any stale session
                const sessionId = msg.sessionId || `live_${Date.now()}`;
                try {
                    const session = await liveService.connect({
                        onAudio(b64, mimeType) {
                            if (!state)
                                return;
                            // Record TTFA on first chunk
                            if (state.firstAudioAt === 0) {
                                state.firstAudioAt = Date.now();
                            }
                            state.audioChunks++;
                            send({ type: "audio", data: b64, mimeType });
                        },
                        // Input STT is not shown in the UI — only signal end-of-user-audio for the dots bubble.
                        onInputTranscript(_text, finished) {
                            if (!state)
                                return;
                            if (finished)
                                send({ type: "user_audio_end" });
                        },
                        onEndOfUserSpeech() {
                            if (!state)
                                return;
                            send({ type: "user_audio_end" });
                        },
                        onOutputTranscript(text, finished) {
                            if (!state)
                                return;
                            state.botTranscriptRaw += text;
                            // Stream Live outputAudioTranscription to the client immediately (partial + final raw).
                            if (state.botTranscriptRaw.trim()) {
                                send({
                                    type: "bot_text",
                                    text: state.botTranscriptRaw,
                                    finished,
                                });
                            }
                            if (!finished)
                                return;
                            const snap = state.botTranscriptRaw;
                            void (async () => {
                                if (!snap.trim())
                                    return;
                                try {
                                    const en = await gemini.englishBotTranscriptDisplay(snap);
                                    if (!state)
                                        return;
                                    state.liveBotCaptionEn = en;
                                    send({ type: "bot_text", text: en, finished: true });
                                }
                                catch {
                                    if (!state)
                                        return;
                                    const fallback = (0, services_1.assertAsciiEnglishUserCaption)(snap);
                                    state.liveBotCaptionEn = fallback;
                                    send({ type: "bot_text", text: fallback, finished: true });
                                }
                            })();
                        },
                        onUsageMetadata(um) {
                            if (!state)
                                return;
                            state.pendingUsage.prompt += um.promptTokenCount ?? 0;
                            state.pendingUsage.response += um.responseTokenCount ?? 0;
                            state.pendingUsage.thoughts += um.thoughtsTokenCount ?? 0;
                            if (um.totalTokenCount != null) {
                                state.sessionMaxTotalReported = Math.max(state.sessionMaxTotalReported, um.totalTokenCount);
                            }
                            if (um.totalTokenCount != null ||
                                um.promptTokenCount != null ||
                                um.responseTokenCount != null) {
                                console.log(`[Live usage] ${state.sessionId.slice(0, 8)}…  ` +
                                    `total=${um.totalTokenCount ?? "—"}  prompt=${um.promptTokenCount ?? "—"}  ` +
                                    `response=${um.responseTokenCount ?? "—"}  thoughts=${um.thoughtsTokenCount ?? "—"}`);
                            }
                        },
                        onTurnComplete() {
                            if (!state)
                                return;
                            const st = state;
                            const now = Date.now();
                            const ttfa = st.firstAudioAt ? st.firstAudioAt - st.turnStart : 0;
                            const totalResp = st.turnStart ? now - st.turnStart : 0;
                            const turnP = st.pendingUsage.prompt;
                            const turnR = st.pendingUsage.response;
                            const turnT = st.pendingUsage.thoughts;
                            st.pendingUsage = { prompt: 0, response: 0, thoughts: 0 };
                            st.cumulativePrompt += turnP;
                            st.cumulativeResponse += turnR;
                            st.cumulativeThoughts += turnT;
                            const summed = st.cumulativePrompt + st.cumulativeResponse + st.cumulativeThoughts;
                            const sessionTotalAfterTurn = st.sessionMaxTotalReported > 0 ? st.sessionMaxTotalReported : summed;
                            st.turnIndex++;
                            (0, metrics_1.recordLiveTurn)({
                                sessionId: st.sessionId,
                                turnIndex: st.turnIndex,
                                inputMode: "live-voice",
                                timestamp: new Date().toISOString(),
                                userTranscript: "(voice)",
                                botResponseText: st.liveBotCaptionEn.trim() || st.botTranscriptRaw.trim(),
                                ttfa_ms: ttfa,
                                totalResponse_ms: totalResp,
                                audioChunksReceived: st.audioChunks,
                                usagePromptTokens: turnP,
                                usageResponseTokens: turnR,
                                usageThoughtsTokens: turnT,
                                usageSessionTotalAfterTurn: sessionTotalAfterTurn,
                            });
                            st.turnStart = 0;
                            st.firstAudioAt = 0;
                            st.audioChunks = 0;
                            st.botTranscriptRaw = "";
                            st.liveBotCaptionEn = "";
                            send({ type: "turn_complete" });
                        },
                        onInterrupted() {
                            if (state) {
                                state.botTranscriptRaw = "";
                                state.liveBotCaptionEn = "";
                                state.pendingUsage = { prompt: 0, response: 0, thoughts: 0 };
                            }
                            send({ type: "interrupted" });
                        },
                        onError(err) {
                            console.error("[WS] Live error:", err.message);
                            send({ type: "error", message: err.message });
                        },
                        onClose() {
                            send({ type: "closed" });
                        },
                    });
                    state = {
                        sessionId, turnIndex: 0, session,
                        turnStart: 0, firstAudioAt: 0, audioChunks: 0,
                        botTranscriptRaw: "", liveBotCaptionEn: "",
                        pendingUsage: { prompt: 0, response: 0, thoughts: 0 },
                        sessionMaxTotalReported: 0,
                        cumulativePrompt: 0,
                        cumulativeResponse: 0,
                        cumulativeThoughts: 0,
                    };
                    send({ type: "ready", sessionId });
                }
                catch (err) {
                    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
                }
                break;
            }
            // ── Bot greeting: triggered by client right after "ready" ───
            // We send text to Gemini to make it speak first. We intentionally
            // do NOT touch state.userTranscript so no user bubble appears.
            case "greet": {
                if (!state)
                    break;
                state.turnStart = Date.now();
                state.firstAudioAt = 0;
                state.audioChunks = 0;
                state.botTranscriptRaw = "";
                state.liveBotCaptionEn = "";
                state.pendingUsage = { prompt: 0, response: 0, thoughts: 0 };
                state.session.sendText(prompts_1.OPENING_GREET_USER_TURN);
                break;
            }
            // ── Manual VAD signals ───────────────────────────────────────
            case "activity_start": {
                if (!state)
                    break;
                if (state.turnStart === 0)
                    state.turnStart = Date.now();
                state.session.startActivity();
                break;
            }
            case "activity_end": {
                if (!state)
                    break;
                state.session.endActivity();
                break;
            }
            // ── Audio chunk from browser mic ────────────────────────────
            case "audio": {
                if (!state)
                    break;
                if (state.turnStart === 0)
                    state.turnStart = Date.now(); // mark turn start on first chunk
                state.session.sendAudio(msg.data);
                break;
            }
            // ── Text sent through live session ──────────────────────────
            case "text": {
                if (!state)
                    break;
                state.turnStart = Date.now();
                state.firstAudioAt = 0;
                state.audioChunks = 0;
                state.botTranscriptRaw = "";
                state.liveBotCaptionEn = "";
                state.pendingUsage = { prompt: 0, response: 0, thoughts: 0 };
                state.session.sendText(msg.text);
                break;
            }
            // ── Close live session ───────────────────────────────────────
            case "close": {
                if (state) {
                    (0, metrics_1.saveLiveSessionReport)(state.sessionId);
                    state.session.close();
                    state = null;
                }
                break;
            }
        }
    });
    ws.on("close", () => {
        if (state) {
            (0, metrics_1.saveLiveSessionReport)(state.sessionId);
            state.session.close();
            state = null;
        }
    });
});
// ── Start ─────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`\n🏏  IPL 2026 FAQ Bot  →  http://localhost:${PORT}`);
    console.log(`🎙️  Live API model     →  ${process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-preview-native-audio-dialog"}`);
    console.log(`📄  Session reports   →  logs/\n`);
});
