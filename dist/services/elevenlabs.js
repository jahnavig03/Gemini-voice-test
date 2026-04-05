"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElevenLabsService = void 0;
// src/services/elevenlabs.ts
const elevenlabs_js_1 = require("@elevenlabs/elevenlabs-js");
class ElevenLabsService {
    constructor() {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey)
            throw new Error("ELEVENLABS_API_KEY is not set in .env");
        this.client = new elevenlabs_js_1.ElevenLabsClient({ apiKey });
        this.voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
        this.ttsModelId = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
        this.sttModel = process.env.ELEVENLABS_STT_MODEL || "scribe_v2";
    }
    /**
     * SPEECH-TO-TEXT
     * Accepts a Buffer (audio blob from browser) and returns transcript text.
     */
    async transcribe(audioBuffer, mimeType = "audio/webm") {
        const startTime = Date.now();
        // ElevenLabs STT expects a File-like object with name + type
        const audioBlob = new Blob([audioBuffer], { type: mimeType });
        const audioFile = new File([audioBlob], "recording.webm", { type: mimeType });
        const result = await this.client.speechToText.convert({
            file: audioFile,
            modelId: this.sttModel,
            tagAudioEvents: false, // cleaner transcript for voice bots
            diarize: false,
        });
        const latencyMs = Date.now() - startTime;
        console.log(`[STT] latency: ${latencyMs}ms | transcript: "${result.text?.slice(0, 80)}"`);
        return result.text ?? "";
    }
    /**
     * TEXT-TO-SPEECH
     * Returns a Buffer of MP3 audio from text.
     */
    async synthesize(text) {
        const startTime = Date.now();
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
        // Collect stream into a Buffer
        const chunks = [];
        for await (const chunk of audioStream) {
            chunks.push(chunk);
        }
        const audioBuffer = Buffer.concat(chunks);
        const latencyMs = Date.now() - startTime;
        console.log(`[TTS] latency: ${latencyMs}ms | bytes: ${audioBuffer.length} | model: ${this.ttsModelId}`);
        return audioBuffer;
    }
}
exports.ElevenLabsService = ElevenLabsService;
