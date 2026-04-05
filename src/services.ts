// src/services.ts
import { GoogleGenerativeAI, ChatSession } from "@google/generative-ai";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { IPL_SYSTEM_PROMPT, OPENING_GREET_USER_TURN } from "./prompts";

/** Scripts we never show in the live user caption bubble (must be English / Latin). */
const NON_LATIN_DISPLAY_SCRIPT_RE =
  /[\u0900-\u0AFF\u0980-\u09FF\u0A00-\u0AFF\u0B00-\u0B7F\u0C00-\u0C7F\u0600-\u06FF\u0590-\u05FF\u0400-\u04FF\u0370-\u03FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0E00-\u0E7F]/;

function captionContainsBlockedScript(s: string): boolean {
  return NON_LATIN_DISPLAY_SCRIPT_RE.test(s);
}

/** Safe to show in UI: no Indic/CJK/Arabic/Cyrillic, and has some Latin letters. */
export function isEnglishLatinCaption(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (captionContainsBlockedScript(t)) return false;
  return /[a-zA-Z]/.test(t);
}

const CAPTION_PLACEHOLDER = "(Caption not available in English — try again)";

/** Final gate before WS send: printable ASCII only (no Devanagari, smart quotes, etc.). */
export function assertAsciiEnglishUserCaption(s: string): string {
  const t = s.trim();
  if (!t) return t;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 0x20 || c > 0x7e) {
      console.warn("[LiveCaption] Blocked non-ASCII character in user caption at index", i);
      return CAPTION_PLACEHOLDER;
    }
  }
  if (!/[a-zA-Z]/.test(t)) return CAPTION_PLACEHOLDER;
  return t;
}

// ── Gemini Service ────────────────────────────────────────────────

export class GeminiService {
  private client: GoogleGenerativeAI;
  private sessions: Map<string, ChatSession> = new Map();

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set in .env");
    this.client = new GoogleGenerativeAI(apiKey);
  }

  private getSession(sessionId: string): ChatSession {
    if (!this.sessions.has(sessionId)) {
      const textModel = process.env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash";
      const model = this.client.getGenerativeModel({
        model: textModel,
        systemInstruction: IPL_SYSTEM_PROMPT,
      });
      const chat = model.startChat({
        history: [],
        generationConfig: {
          maxOutputTokens: 250,
          temperature: 0.65,
          topP: 0.9,
        },
      });
      this.sessions.set(sessionId, chat);
    }
    return this.sessions.get(sessionId)!;
  }

  async chat(sessionId: string, userText: string): Promise<string> {
    const session = this.getSession(sessionId);
    const t0 = Date.now();
    const result = await session.sendMessage(userText);
    const text = result.response.text();
    console.log(`[Gemini] ${Date.now() - t0}ms | "${text.slice(0, 60)}..."`);
    return text;
  }

  /**
   * Opening greeting when the chat opens — standalone generateContent so REST chat history
   * for `sessionId` stays empty until the user's first real message.
   */
  async welcomeChatOpening(): Promise<string> {
    const textModel = process.env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash";
    const model = this.client.getGenerativeModel({
      model: textModel,
      systemInstruction: IPL_SYSTEM_PROMPT,
    });
    const t0 = Date.now();
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: OPENING_GREET_USER_TURN }] }],
      generationConfig: {
        maxOutputTokens: 512,
        temperature: 0.75,
        topP: 0.9,
      },
    });
    let out = GeminiService.concatGenerateContentText(result).replace(/\s+/g, " ").trim();
    console.log(`[Gemini welcome] ${Date.now() - t0}ms | "${out.slice(0, 100)}..."`);
    if (!out) {
      out =
        "Hey! I'm your IPL 2026 sidekick — schedules, teams, tickets, whatever you need. Type a question or tap the mic to go live!";
    }
    return out;
  }

  /** Join all text parts from candidates (avoids truncated `.text()` when response is split). */
  private static concatGenerateContentText(result: {
    response: {
      text: () => string;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
  }): string {
    try {
      const parts = result.response.candidates?.[0]?.content?.parts;
      if (parts?.length) {
        const joined = parts.map((p) => p.text ?? "").join("");
        if (joined.trim()) return joined;
      }
    } catch {
      /* use fallback below */
    }
    try {
      return result.response.text();
    } catch {
      return "";
    }
  }

  /**
   * Live STT often emits Devanagari/Telugu/etc. We always produce English (Latin, allowed punctuation)
   * for the chat bubble. Never returns raw Indic/CJK text — falls back to a short English placeholder.
   */
  async englishLiveCaption(raw: string): Promise<string> {
    const t = raw.trim();
    if (!t) return t;

    // Never trust "looks like Latin" alone — mixed or odd Unicode can slip through STT.
    if (/^[\x20-\x7E]+$/.test(t) && isEnglishLatinCaption(t)) {
      const u = t.length > 800 ? t.slice(0, 800) : t;
      return assertAsciiEnglishUserCaption(u);
    }

    const model = this.client.getGenerativeModel({
      model: "gemini-2.0-flash",
      generationConfig: { maxOutputTokens: 256, temperature: 0 },
    });

    const loose =
      "You normalize voice-assistant chat captions for an English-only chat log.\n\n" +
      "Output exactly ONE line in ENGLISH using ONLY ASCII: letters A-Z and a-z, digits 0-9, space, and . , ? ! ' - : ; ( ). No other characters.\n" +
      "The raw text may be Devanagari/Telugu phonetic English, real Hindi/Telugu, or mixed. Write what the user meant in normal English.\n" +
      "Example: Hindi script phonetic 'Who is captain of MI' → Who is the captain of Mumbai Indians?\n" +
      "No labels, no quotes around the whole line, no explanation.\n\n" +
      "Raw caption:\n" +
      t;

    const strict =
      "The input uses non-Latin scripts or wrong script for English speech. Output exactly ONE line.\n" +
      "Use ONLY these characters: A-Z a-z 0-9 space . , ? ! ' - : ; ( )\n" +
      "Transliterate everything into English words. Zero Devanagari, Telugu, Arabic, or Chinese characters.\n\n" +
      "Input:\n" +
      t;

    const t0 = Date.now();
    const run = async (p: string) => {
      const result = await model.generateContent(p);
      let o = result.response.text().trim().replace(/^["']|["']$/g, "");
      o = o.split(/\n/)[0]?.trim() ?? "";
      return o;
    };

    let out = await run(loose);
    out = assertAsciiEnglishUserCaption(out);
    if (out === CAPTION_PLACEHOLDER) {
      out = await run(strict);
      out = assertAsciiEnglishUserCaption(out);
    }
    if (out === CAPTION_PLACEHOLDER) {
      console.warn("[LiveCaption] Model output failed ASCII English gate.");
      return out;
    }
    console.log(`[LiveCaption] ${Date.now() - t0}ms english | "${out.slice(0, 72)}..."`);
    return out.length > 800 ? out.slice(0, 800) : out;
  }

  /**
   * Output-audio STT may be Hindi/Telugu/English. The chat log shows English only.
   * Produces one ASCII English line from the assistant's spoken transcript.
   */
  async englishBotTranscriptDisplay(raw: string): Promise<string> {
    const t = raw.trim();
    if (!t) return t;

    if (/^[\x20-\x7E]+$/.test(t) && isEnglishLatinCaption(t)) {
      const u = t.length > 800 ? t.slice(0, 800) : t;
      return assertAsciiEnglishUserCaption(u);
    }

    const model = this.client.getGenerativeModel({
      model: "gemini-2.0-flash",
      generationConfig: { maxOutputTokens: 256, temperature: 0 },
    });

    const loose =
      "Below is a speech-to-text transcript of what an IPL voice assistant said aloud to the user.\n" +
      "It may be Hindi, Telugu, English, Hinglish, or noisy STT.\n\n" +
      "Output exactly ONE line in ENGLISH using ONLY ASCII: letters A-Z and a-z, digits 0-9, space, and . , ? ! ' - : ; ( ). No other characters.\n" +
      "Translate faithfully into natural English. Keep IPL team names, player names, dates, and the intent of any follow-up question.\n" +
      "No labels, no wrapping quotes, no explanation.\n\n" +
      "Transcript:\n" +
      t;

    const strict =
      "The transcript uses non-Latin scripts or mixed text. Output exactly ONE line: a faithful English translation.\n" +
      "Use ONLY: A-Z a-z 0-9 space . , ? ! ' - : ; ( )\n" +
      "No Devanagari, Telugu, Arabic, or Chinese characters.\n\n" +
      "Transcript:\n" +
      t;

    const t0 = Date.now();
    const run = async (p: string) => {
      const result = await model.generateContent(p);
      let o = result.response.text().trim().replace(/^["']|["']$/g, "");
      o = o.split(/\n/)[0]?.trim() ?? "";
      return o;
    };

    let out = await run(loose);
    out = assertAsciiEnglishUserCaption(out);
    if (out === CAPTION_PLACEHOLDER) {
      out = await run(strict);
      out = assertAsciiEnglishUserCaption(out);
    }
    if (out === CAPTION_PLACEHOLDER) {
      console.warn("[BotCaption] Model output failed ASCII English gate.");
      return out;
    }
    console.log(`[BotCaption] ${Date.now() - t0}ms english | "${out.slice(0, 72)}..."`);
    return out.length > 800 ? out.slice(0, 800) : out;
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    console.log(`[Gemini] Session cleared: ${sessionId}`);
  }

  get activeSessions(): number {
    return this.sessions.size;
  }
}

// ── ElevenLabs Service ─────────────────────────────────────────────

export class ElevenLabsService {
  private client: ElevenLabsClient;
  private voiceId: string;
  private ttsModelId: string;
  private sttModel: string;

  constructor() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set in .env");

    this.client = new ElevenLabsClient({ apiKey });
    this.voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
    this.ttsModelId = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
    this.sttModel = process.env.ELEVENLABS_STT_MODEL || "scribe_v2";
  }

  async transcribe(audioBuffer: Buffer, mimeType: string = "audio/webm"): Promise<string> {
    const t0 = Date.now();
    const audioBlob = new Blob([audioBuffer], { type: mimeType });
    const audioFile = new File([audioBlob], "recording.webm", { type: mimeType });

    const result = await this.client.speechToText.convert({
      file: audioFile,
      modelId: this.sttModel as any,
      tagAudioEvents: false,
      diarize: false,
    });

    console.log(`[STT] ${Date.now() - t0}ms | "${result.text?.slice(0, 80)}"`);
    return result.text ?? "";
  }

  async synthesize(text: string): Promise<Buffer> {
    const t0 = Date.now();
    const audioStream = await this.client.textToSpeech.convert(this.voiceId, {
      text,
      modelId: this.ttsModelId,
      voiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0.0,
        useSpeakerBoost: true,
      },
    });

    const chunks: Buffer[] = [];
    for await (const chunk of audioStream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);
    console.log(`[TTS] ${Date.now() - t0}ms | ${audioBuffer.length} bytes`);
    return audioBuffer;
  }
}
