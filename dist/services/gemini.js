"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiService = void 0;
// src/services/gemini.ts
const generative_ai_1 = require("@google/generative-ai");
const SYSTEM_PROMPT = `You are a helpful, concise voice assistant. 
Rules:
- Keep responses SHORT (2-4 sentences max) — they will be spoken aloud.
- Never use markdown, bullet points, or special characters.
- Speak naturally, like a person would in a conversation.
- If you don't know something, say so simply.
- Avoid filler phrases like "Certainly!" or "Great question!".`;
class GeminiService {
    constructor() {
        this.sessions = new Map();
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey)
            throw new Error("GEMINI_API_KEY is not set in .env");
        this.client = new generative_ai_1.GoogleGenerativeAI(apiKey);
    }
    /** Get or create a chat session for a given sessionId */
    getSession(sessionId) {
        if (!this.sessions.has(sessionId)) {
            const model = this.client.getGenerativeModel({
                model: "gemini-2.5-flash",
                systemInstruction: SYSTEM_PROMPT,
            });
            const chat = model.startChat({
                history: [],
                generationConfig: {
                    maxOutputTokens: 300, // Keep TTS short
                    temperature: 0.7,
                    topP: 0.9,
                },
            });
            this.sessions.set(sessionId, chat);
        }
        return this.sessions.get(sessionId);
    }
    /** Send a user message and return the assistant text */
    async chat(sessionId, userText) {
        const session = this.getSession(sessionId);
        const startTime = Date.now();
        const result = await session.sendMessage(userText);
        const text = result.response.text();
        const latencyMs = Date.now() - startTime;
        console.log(`[Gemini] latency: ${latencyMs}ms | tokens_in: ~${userText.split(" ").length * 1.3 | 0} | response: "${text.slice(0, 60)}..."`);
        return text;
    }
    /** Clear a session (reset conversation history) */
    clearSession(sessionId) {
        this.sessions.delete(sessionId);
        console.log(`[Gemini] Session ${sessionId} cleared.`);
    }
    /** List active sessions */
    get activeSessions() {
        return this.sessions.size;
    }
}
exports.GeminiService = GeminiService;
