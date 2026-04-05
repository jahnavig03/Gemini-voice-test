"use strict";
// src/utils/metrics.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordTurn = recordTurn;
exports.getMetrics = getMetrics;
exports.getSummary = getSummary;
const log = [];
function recordTurn(metrics) {
    log.push(metrics);
    console.log(`\n📊 [METRICS] Turn #${metrics.turnIndex}` +
        `\n  STT : ${metrics.latency.stt_ms}ms` +
        `\n  LLM : ${metrics.latency.llm_ms}ms` +
        `\n  TTS : ${metrics.latency.tts_ms}ms` +
        `\n  TOTAL: ${metrics.latency.total_ms}ms\n`);
}
function getMetrics() {
    return log;
}
function getSummary() {
    if (log.length === 0)
        return null;
    const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    return {
        turns: log.length,
        avg_stt_ms: avg(log.map(m => m.latency.stt_ms)),
        avg_llm_ms: avg(log.map(m => m.latency.llm_ms)),
        avg_tts_ms: avg(log.map(m => m.latency.tts_ms)),
        avg_total_ms: avg(log.map(m => m.latency.total_ms)),
    };
}
