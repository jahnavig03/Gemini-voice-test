"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/voice.ts
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const gemini_1 = require("../services/gemini");
const elevenlabs_1 = require("../services/elevenlabs");
const metrics_1 = require("../utils/metrics");
const router = (0, express_1.Router)();
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
const gemini = new gemini_1.GeminiService();
const eleven = new elevenlabs_1.ElevenLabsService();
// Track turn count per session
const sessionTurnCount = {};
/**
 * POST /api/voice/turn
 * Full pipeline: audio → STT → Gemini → TTS → audio back
 * Body: multipart/form-data
 *   - audio: audio blob (webm/ogg/mp3/wav)
 *   - sessionId: string (optional, auto-generated if absent)
 */
router.post("/turn", upload.single("audio"), async (req, res) => {
    const sessionId = req.body.sessionId || `session_${Date.now()}`;
    if (!req.file) {
        res.status(400).json({ error: "No audio file uploaded." });
        return;
    }
    sessionTurnCount[sessionId] = (sessionTurnCount[sessionId] ?? 0) + 1;
    const turnIndex = sessionTurnCount[sessionId];
    try {
        const t0 = Date.now();
        // ── 1. STT ─────────────────────────────────────────────────
        const t1 = Date.now();
        const transcript = await eleven.transcribe(req.file.buffer, req.file.mimetype);
        const stt_ms = Date.now() - t1;
        if (!transcript.trim()) {
            res.status(200).json({ error: "Could not transcribe audio. Please try again." });
            return;
        }
        // ── 2. LLM ─────────────────────────────────────────────────
        const t2 = Date.now();
        const reply = await gemini.chat(sessionId, transcript);
        const llm_ms = Date.now() - t2;
        // ── 3. TTS ─────────────────────────────────────────────────
        const t3 = Date.now();
        const audioBuffer = await eleven.synthesize(reply);
        const tts_ms = Date.now() - t3;
        const total_ms = Date.now() - t0;
        // ── 4. Record metrics ──────────────────────────────────────
        (0, metrics_1.recordTurn)({
            sessionId,
            turnIndex,
            transcript,
            geminiResponse: reply,
            latency: { stt_ms, llm_ms, tts_ms, total_ms },
            timestamp: new Date().toISOString(),
        });
        // ── 5. Return audio + metadata headers ─────────────────────
        res.set({
            "Content-Type": "audio/mpeg",
            "X-Transcript": encodeURIComponent(transcript),
            "X-Reply-Text": encodeURIComponent(reply),
            "X-Session-Id": sessionId,
            "X-Latency-STT": String(stt_ms),
            "X-Latency-LLM": String(llm_ms),
            "X-Latency-TTS": String(tts_ms),
            "X-Latency-Total": String(total_ms),
        });
        res.send(audioBuffer);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[ERROR]", msg);
        res.status(500).json({ error: msg });
    }
});
/**
 * POST /api/voice/text-turn
 * Pipeline without audio input: text → Gemini → TTS
 * Useful for quick testing without a microphone
 * Body: { text: string, sessionId?: string }
 */
router.post("/text-turn", async (req, res) => {
    const { text, sessionId = `session_${Date.now()}` } = req.body;
    if (!text?.trim()) {
        res.status(400).json({ error: "text field is required." });
        return;
    }
    sessionTurnCount[sessionId] = (sessionTurnCount[sessionId] ?? 0) + 1;
    const turnIndex = sessionTurnCount[sessionId];
    try {
        const t0 = Date.now();
        const t2 = Date.now();
        const reply = await gemini.chat(sessionId, text);
        const llm_ms = Date.now() - t2;
        const t3 = Date.now();
        const audioBuffer = await eleven.synthesize(reply);
        const tts_ms = Date.now() - t3;
        const total_ms = Date.now() - t0;
        (0, metrics_1.recordTurn)({
            sessionId,
            turnIndex,
            transcript: text,
            geminiResponse: reply,
            latency: { stt_ms: 0, llm_ms, tts_ms, total_ms },
            timestamp: new Date().toISOString(),
        });
        res.set({
            "Content-Type": "audio/mpeg",
            "X-Reply-Text": encodeURIComponent(reply),
            "X-Session-Id": sessionId,
            "X-Latency-LLM": String(llm_ms),
            "X-Latency-TTS": String(tts_ms),
            "X-Latency-Total": String(total_ms),
        });
        res.send(audioBuffer);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[ERROR]", msg);
        res.status(500).json({ error: msg });
    }
});
/** DELETE /api/voice/session/:id — clear conversation history */
router.delete("/session/:id", (req, res) => {
    gemini.clearSession(req.params.id);
    delete sessionTurnCount[req.params.id];
    res.json({ ok: true, message: `Session ${req.params.id} cleared.` });
});
/** GET /api/voice/metrics — view all performance data */
router.get("/metrics", (_req, res) => {
    res.json({ summary: (0, metrics_1.getSummary)(), turns: (0, metrics_1.getMetrics)() });
});
exports.default = router;
