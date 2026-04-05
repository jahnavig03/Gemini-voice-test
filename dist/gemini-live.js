"use strict";
// src/gemini-live.ts — Gemini Live API bridge (@google/genai v1.x)
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiLiveService = void 0;
const genai_1 = require("@google/genai");
const prompts_1 = require("./prompts");
const gemini_errors_1 = require("./gemini-errors");
const env_gemini_1 = require("./env-gemini");
// ── Service ───────────────────────────────────────────────────────
function parseLiveMs(raw, fallback, min, max) {
    const n = parseInt(raw ?? "", 10);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, n));
}
class GeminiLiveService {
    constructor() {
        const key = (0, env_gemini_1.getGeminiApiKey)();
        // Live preview models (gemini-*-live-preview-*) only exist on v1alpha,
        // not on the default v1beta endpoint.
        this.ai = new genai_1.GoogleGenAI({ apiKey: key, apiVersion: "v1alpha" });
    }
    async connect(cb) {
        // Live API model — all preview models require apiVersion: "v1alpha" (set in constructor)
        // gemini-2.5-flash-native-audio-preview-12-2025  ← native audio, best quality
        // gemini-2.0-flash-live-preview-04-09            ← stable fallback
        const model = process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-preview-12-2025";
        const voice = process.env.GEMINI_VOICE ?? "Puck";
        const silenceDurationMs = parseLiveMs(process.env.GEMINI_LIVE_SILENCE_MS, 120, 80, 800);
        const prefixPaddingMs = parseLiveMs(process.env.GEMINI_LIVE_PREFIX_MS, 12, 0, 500);
        // Input STT off by default: it often writes English-with-accent in Devanagari/Telugu script,
        // which the model then treats as Hindi/Telugu and answers wrongly. Opt in with GEMINI_LIVE_INPUT_TRANSCRIPTION=1.
        const inputTranscriptionOn = process.env.GEMINI_LIVE_INPUT_TRANSCRIPTION === "1";
        console.log(`[Live] 🔄 Connecting  model=${model}  voice=${voice}  ` +
            `silence=${silenceDurationMs}ms  prefix=${prefixPaddingMs}ms  inputSTT=${inputTranscriptionOn}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await this.ai.live.connect({
            model,
            config: {
                // Request AUDIO modality for spoken responses
                responseModalities: ["AUDIO"],
                // Input STT: off unless GEMINI_LIVE_INPUT_TRANSCRIPTION=1. When on, wrong-script STT biases reply language.
                // user_audio_end uses server VAD (voiceActivity) when STT is off.
                // Output STT: always on — drives streaming bot bubbles; server may normalize to English on final.
                ...(inputTranscriptionOn ? { inputAudioTranscription: {} } : {}),
                ...(process.env.GEMINI_LIVE_OUTPUT_TRANSCRIPTION === "0"
                    ? {}
                    : { outputAudioTranscription: {} }),
                systemInstruction: prompts_1.IPL_SYSTEM_PROMPT,
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: voice },
                    },
                },
                // Turn-taking: shorter silence / prefix = lower latency (risk: false EOS or chopping mid-pause).
                // Tune with GEMINI_LIVE_SILENCE_MS / GEMINI_LIVE_PREFIX_MS. VAD signals still drive user_audio_end.
                realtimeInputConfig: {
                    activityHandling: genai_1.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
                    automaticActivityDetection: {
                        disabled: false,
                        startOfSpeechSensitivity: genai_1.StartSensitivity.START_SENSITIVITY_HIGH,
                        endOfSpeechSensitivity: genai_1.EndSensitivity.END_SENSITIVITY_HIGH,
                        prefixPaddingMs,
                        silenceDurationMs,
                    },
                },
                // Avoid extra "should I respond?" gating — reduces perceived delay before first token/audio
                proactivity: { proactiveAudio: false },
            },
            callbacks: {
                onopen: () => {
                    console.log(`[Live] ✅ Connected  model=${model}  voice=${voice}`);
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onmessage: (msg) => {
                    try {
                        // ── Server VAD: end of user speech (often before inputTranscription.finished) ──
                        const va = msg?.voiceActivity?.voiceActivityType;
                        const vad = msg?.voiceActivityDetectionSignal?.vadSignalType;
                        if (va === "ACTIVITY_END" || vad === "VAD_SIGNAL_TYPE_EOS") {
                            cb.onEndOfUserSpeech();
                        }
                        const sc = msg?.serverContent;
                        // ── setupComplete ─────────────────────────────────────
                        if (msg?.setupComplete) {
                            console.log("[Live] 🟢 Setup complete — session ready");
                            return;
                        }
                        // ── usageMetadata (top-level on LiveServerMessage; not inside serverContent) ──
                        const um = msg?.usageMetadata;
                        if (um &&
                            (um.totalTokenCount != null ||
                                um.promptTokenCount != null ||
                                um.responseTokenCount != null ||
                                um.thoughtsTokenCount != null ||
                                um.toolUsePromptTokenCount != null ||
                                um.cachedContentTokenCount != null)) {
                            cb.onUsageMetadata({
                                promptTokenCount: um.promptTokenCount,
                                responseTokenCount: um.responseTokenCount,
                                totalTokenCount: um.totalTokenCount,
                                cachedContentTokenCount: um.cachedContentTokenCount,
                                thoughtsTokenCount: um.thoughtsTokenCount,
                                toolUsePromptTokenCount: um.toolUsePromptTokenCount,
                            });
                        }
                        if (!sc)
                            return;
                        // ── Audio parts from model turn ────────────────────────
                        // NOTE: Do NOT forward part.text here — with gemini-2.5-flash
                        // that captures chain-of-thought/thinking text, not the spoken
                        // response. The actual spoken transcript arrives via
                        // sc.outputTranscription below.
                        for (const part of sc.modelTurn?.parts ?? []) {
                            if (part?.inlineData?.data) {
                                cb.onAudio(part.inlineData.data, part.inlineData.mimeType ?? "audio/pcm;rate=24000");
                            }
                        }
                        // ── Input transcription (user speech → text) ──────────
                        if (sc.inputTranscription?.text) {
                            cb.onInputTranscript(sc.inputTranscription.text, sc.inputTranscription.finished ?? false);
                        }
                        // ── Output transcription (bot audio → text) ───────────
                        if (sc.outputTranscription?.text) {
                            cb.onOutputTranscript(sc.outputTranscription.text, sc.outputTranscription.finished ?? false);
                        }
                        // ── Turn events ────────────────────────────────────────
                        if (sc.turnComplete)
                            cb.onTurnComplete();
                        if (sc.interrupted)
                            cb.onInterrupted();
                    }
                    catch (e) {
                        cb.onError(e instanceof Error ? e : new Error(String(e)));
                    }
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onerror: (e) => {
                    const msg = e?.message ?? e?.type ?? String(e);
                    console.error("[Live] ❌ Error:", msg, e);
                    cb.onError(new Error(msg));
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onclose: (e) => {
                    const code = e?.code;
                    const reasonRaw = e?.reason;
                    const reasonStr = typeof reasonRaw === "string"
                        ? reasonRaw
                        : reasonRaw instanceof ArrayBuffer
                            ? new TextDecoder().decode(reasonRaw)
                            : String(reasonRaw ?? "");
                    const reasonLog = reasonStr ? `  reason="${reasonStr.slice(0, 200)}"` : "";
                    const clean = e?.wasClean !== undefined ? `  wasClean=${e.wasClean}` : "";
                    console.log(`[Live] 🔌 Closed  code=${code}${reasonLog}${clean}`);
                    if (code === 1008) {
                        console.error("[Live] ⛔ Policy Violation (1008) — the model name is likely invalid or " +
                            "this API key does not have Live API access.\n" +
                            `       Current model: "${model}"\n` +
                            "       Try: gemini-2.0-flash-live-preview-04-09  or  gemini-live-2.5-flash-preview");
                        const f = (0, gemini_errors_1.formatGeminiUserError)(new Error(`403 Forbidden Live WebSocket (code 1008). Model may be invalid or this API key lacks Live API access. Current model: ${model}`));
                        cb.onError(new Error(f.message));
                    }
                    else if (/leaked|403|forbidden|invalid api key|api key/i.test(reasonStr)) {
                        const f = (0, gemini_errors_1.formatGeminiUserError)(new Error(reasonStr));
                        cb.onError(new Error(f.message));
                    }
                    cb.onClose();
                },
            },
        });
        return {
            sendAudio(b64) {
                raw.sendRealtimeInput({
                    audio: { data: b64, mimeType: "audio/pcm;rate=16000" },
                });
            },
            sendText(text) {
                // sendClientContent sends a complete user turn immediately
                raw.sendClientContent({
                    turns: [{ role: "user", parts: [{ text }] }],
                    turnComplete: true,
                });
            },
            startActivity() {
                raw.sendRealtimeInput({ activityStart: {} });
            },
            endActivity() {
                raw.sendRealtimeInput({ activityEnd: {} });
            },
            close() {
                try {
                    raw.close();
                }
                catch { /* already closed */ }
            },
        };
    }
}
exports.GeminiLiveService = GeminiLiveService;
