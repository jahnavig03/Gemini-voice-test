// src/gemini-live.ts — Gemini Live API bridge (@google/genai v1.x)

import {
  GoogleGenAI,
  StartSensitivity,
  EndSensitivity,
  ActivityHandling,
} from "@google/genai";
import { IPL_SYSTEM_PROMPT } from "./prompts";

// ── Callback surface exposed to server.ts ─────────────────────────

/** Subset of Live API UsageMetadata forwarded for session accounting */
export interface LiveUsageSnapshot {
  promptTokenCount?: number;
  responseTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

export interface LiveCallbacks {
  onAudio(base64: string, mimeType: string): void;
  onInputTranscript(text: string, finished: boolean): void;  // user speech → text
  /** Server VAD end-of-utterance — usually arrives before input STT `finished`; use for snappier UI */
  onEndOfUserSpeech(): void;
  onOutputTranscript(text: string, finished: boolean): void; // bot speech → text
  /** Token usage from Live messages (may arrive without serverContent) */
  onUsageMetadata(usage: LiveUsageSnapshot): void;
  onTurnComplete(): void;
  onInterrupted(): void;
  onError(err: Error): void;
  onClose(): void;
}

export interface LiveSession {
  sendAudio(base64PCM: string): void;
  sendText(text: string): void;
  startActivity(): void;
  endActivity(): void;
  close(): void;
}

// ── Service ───────────────────────────────────────────────────────

function parseLiveMs(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export class GeminiLiveService {
  private ai: GoogleGenAI;

  constructor() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY not set");
    // Live preview models (gemini-*-live-preview-*) only exist on v1alpha,
    // not on the default v1beta endpoint.
    this.ai = new GoogleGenAI({ apiKey: key, apiVersion: "v1alpha" });
  }

  async connect(cb: LiveCallbacks): Promise<LiveSession> {
    // Live API model — all preview models require apiVersion: "v1alpha" (set in constructor)
    // gemini-2.5-flash-native-audio-preview-12-2025  ← native audio, best quality
    // gemini-2.0-flash-live-preview-04-09            ← stable fallback
    const model = process.env.GEMINI_LIVE_MODEL ?? "gemini-2.5-flash-native-audio-preview-12-2025";
    const voice = process.env.GEMINI_VOICE      ?? "Puck";

    const silenceDurationMs = parseLiveMs(process.env.GEMINI_LIVE_SILENCE_MS, 120, 80, 800);
    const prefixPaddingMs   = parseLiveMs(process.env.GEMINI_LIVE_PREFIX_MS, 12, 0, 500);
    // Input STT off by default: it often writes English-with-accent in Devanagari/Telugu script,
    // which the model then treats as Hindi/Telugu and answers wrongly. Opt in with GEMINI_LIVE_INPUT_TRANSCRIPTION=1.
    const inputTranscriptionOn = process.env.GEMINI_LIVE_INPUT_TRANSCRIPTION === "1";

    console.log(
      `[Live] 🔄 Connecting  model=${model}  voice=${voice}  ` +
        `silence=${silenceDurationMs}ms  prefix=${prefixPaddingMs}ms  inputSTT=${inputTranscriptionOn}`
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = await (this.ai as any).live.connect({
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

        systemInstruction: IPL_SYSTEM_PROMPT,

        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },

        // Turn-taking: shorter silence / prefix = lower latency (risk: false EOS or chopping mid-pause).
        // Tune with GEMINI_LIVE_SILENCE_MS / GEMINI_LIVE_PREFIX_MS. VAD signals still drive user_audio_end.
        realtimeInputConfig: {
          activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
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
        onmessage: (msg: any) => {
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
            const um = msg?.usageMetadata as LiveUsageSnapshot | undefined;
            if (
              um &&
              (um.totalTokenCount != null ||
                um.promptTokenCount != null ||
                um.responseTokenCount != null ||
                um.thoughtsTokenCount != null ||
                um.toolUsePromptTokenCount != null ||
                um.cachedContentTokenCount != null)
            ) {
              cb.onUsageMetadata({
                promptTokenCount: um.promptTokenCount,
                responseTokenCount: um.responseTokenCount,
                totalTokenCount: um.totalTokenCount,
                cachedContentTokenCount: um.cachedContentTokenCount,
                thoughtsTokenCount: um.thoughtsTokenCount,
                toolUsePromptTokenCount: um.toolUsePromptTokenCount,
              });
            }

            if (!sc) return;

            // ── Audio parts from model turn ────────────────────────
            // NOTE: Do NOT forward part.text here — with gemini-2.5-flash
            // that captures chain-of-thought/thinking text, not the spoken
            // response. The actual spoken transcript arrives via
            // sc.outputTranscription below.
            for (const part of sc.modelTurn?.parts ?? []) {
              if (part?.inlineData?.data) {
                cb.onAudio(
                  part.inlineData.data,
                  part.inlineData.mimeType ?? "audio/pcm;rate=24000"
                );
              }
            }

            // ── Input transcription (user speech → text) ──────────
            if (sc.inputTranscription?.text) {
              cb.onInputTranscript(
                sc.inputTranscription.text,
                sc.inputTranscription.finished ?? false
              );
            }

            // ── Output transcription (bot audio → text) ───────────
            if (sc.outputTranscription?.text) {
              cb.onOutputTranscript(
                sc.outputTranscription.text,
                sc.outputTranscription.finished ?? false
              );
            }

            // ── Turn events ────────────────────────────────────────
            if (sc.turnComplete)  cb.onTurnComplete();
            if (sc.interrupted)   cb.onInterrupted();

          } catch (e) {
            cb.onError(e instanceof Error ? e : new Error(String(e)));
          }
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onerror: (e: any) => {
          const msg = e?.message ?? e?.type ?? String(e);
          console.error("[Live] ❌ Error:", msg, e);
          cb.onError(new Error(msg));
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onclose: (e: any) => {
          const reason = e?.reason ? `  reason="${e.reason}"` : "";
          const clean  = e?.wasClean !== undefined ? `  wasClean=${e.wasClean}` : "";
          console.log(`[Live] 🔌 Closed  code=${e?.code}${reason}${clean}`);
          if (e?.code === 1008) {
            console.error(
              "[Live] ⛔ Policy Violation (1008) — the model name is likely invalid or " +
              "this API key does not have Live API access.\n" +
              `       Current model: "${model}"\n` +
              "       Try: gemini-2.0-flash-live-preview-04-09  or  gemini-live-2.5-flash-preview"
            );
          }
          cb.onClose();
        },
      },
    });

    return {
      sendAudio(b64: string) {
        raw.sendRealtimeInput({
          audio: { data: b64, mimeType: "audio/pcm;rate=16000" },
        });
      },
      sendText(text: string) {
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
        try { raw.close(); } catch { /* already closed */ }
      },
    };
  }
}
