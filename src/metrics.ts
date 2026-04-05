// src/metrics.ts
import fs from "fs";
import path from "path";

// ── Interfaces ────────────────────────────────────────────────────

export interface TurnLatency {
  stt_ms: number;   // 0 for text-mode turns
  llm_ms: number;
  tts_ms: number;
  total_ms: number;
}

/** REST pipeline turn (text or ElevenLabs voice) */
export interface TurnMetrics {
  sessionId: string;
  turnIndex: number;
  inputMode: "voice" | "text";
  timestamp: string;
  transcript: string;
  geminiResponse: string;
  latency: TurnLatency;
  transcriptWordCount: number;
  responseWordCount: number;
  transcriptAccuracyNote: string;
  responseQualityScore: number;
  responseQualityNote: string;
}

/** Live API turn (native audio end-to-end) */
export interface LiveTurnMetrics {
  sessionId: string;
  turnIndex: number;
  inputMode: "live-voice" | "live-text";
  timestamp: string;
  userTranscript: string;   // may be empty if VAD path
  botResponseText: string;  // accumulated text parts (if any)
  ttfa_ms: number;          // time to first audio chunk from Gemini
  totalResponse_ms: number; // first-input → turnComplete
  audioChunksReceived: number;
  /** Tokens summed from Live usageMetadata during this turn (prompt/response/thoughts) */
  usagePromptTokens?: number;
  usageResponseTokens?: number;
  usageThoughtsTokens?: number;
  /**
   * Session total after this turn: max reported `totalTokenCount` from the API when present,
   * otherwise running sum of prompt + response + thoughts across turns.
   */
  usageSessionTotalAfterTurn?: number;
}

// ── In-memory stores ──────────────────────────────────────────────

const restLogs: Record<string, TurnMetrics[]>     = {};
const liveLogs: Record<string, LiveTurnMetrics[]> = {};
const LOGS_DIR = path.join(__dirname, "../logs");

const ensureDir = () => {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
};

const TOKEN_USAGE_JSONL = path.join(LOGS_DIR, "token-usage.jsonl");

/** One JSON line per Live markdown report write — easy to aggregate token usage by session. */
export function appendLiveTokenUsageJsonl(entry: {
  sessionId: string;
  turnCount: number;
  usageSessionTotalAfterLastTurn: number | null;
  summedPromptResponseThoughts: number;
}): void {
  ensureDir();
  fs.appendFileSync(
    TOKEN_USAGE_JSONL,
    JSON.stringify({
      kind: "live_session_snapshot",
      at: new Date().toISOString(),
      ...entry,
    }) + "\n",
    "utf8"
  );
}

// ── REST quality helpers ──────────────────────────────────────────

export function computeResponseQuality(response: string): { score: number; note: string } {
  const text = response.trim();
  if (!text) return { score: 0, note: "Empty response" };

  const wc = text.split(/\s+/).filter(Boolean).length;
  let score = 2;
  const reasons: string[] = [];

  if (wc >= 15 && wc <= 60)          { score += 2; reasons.push("ideal voice length"); }
  else if (wc >= 8 || wc <= 80)      { score += 1; reasons.push("acceptable length"); }
  else if (wc < 5 || wc > 100)       { score -= 2; reasons.push(wc < 5 ? "too short" : "too long"); }

  if (/ipl|cricket|team|match|player|wicket|run|over|innings|final|stadium|venue|ticket|season|captain/i.test(text)) {
    score += 2; reasons.push("IPL-relevant");
  }
  if (!/\b(certainly|great question|absolutely|of course|sure thing|happy to help)\b/i.test(text)) {
    score += 1; reasons.push("no filler");
  }
  if (!/^(i |so |well |um |uh )/i.test(text))   { score += 1; reasons.push("direct opener"); }
  if (/[.!?]$/.test(text))                        { score += 1; reasons.push("complete sentence"); }

  return { score: Math.min(10, Math.max(0, score)), note: reasons.join(", ") };
}

export function computeTranscriptAccuracy(mode: "voice" | "text", transcript: string): string {
  if (mode === "text") return "N/A — text input";
  const wc = transcript.trim().split(/\s+/).filter(Boolean).length;
  if (wc === 0)   return "Failed — empty transcript";
  if (wc <= 2)    return "Low — ≤2 words, possible audio quality issue";
  if (wc <= 5)    return "Medium — short phrase";
  return "Good — normal sentence length";
}

// ── REST recording ────────────────────────────────────────────────

export function recordTurn(m: TurnMetrics): void {
  (restLogs[m.sessionId] ??= []).push(m);
  console.log(
    `\n📊 REST Turn #${m.turnIndex} | ${m.inputMode} | STT:${m.latency.stt_ms}ms LLM:${m.latency.llm_ms}ms TTS:${m.latency.tts_ms}ms TOTAL:${m.latency.total_ms}ms | RQ:${m.responseQualityScore}/10`
  );
  saveSessionReport(m.sessionId);
}

// ── Live API recording ────────────────────────────────────────────

export function recordLiveTurn(m: LiveTurnMetrics): void {
  (liveLogs[m.sessionId] ??= []).push(m);
  const tok =
    m.usageSessionTotalAfterTurn != null
      ? ` | session≈${m.usageSessionTotalAfterTurn} tok`
      : "";
  const turnTok =
    (m.usagePromptTokens ?? 0) + (m.usageResponseTokens ?? 0) + (m.usageThoughtsTokens ?? 0);
  const turnDetail =
    turnTok > 0
      ? ` (turn +${m.usagePromptTokens ?? 0}/${m.usageResponseTokens ?? 0}/${m.usageThoughtsTokens ?? 0} p/r/t)`
      : "";
  console.log(
    `\n🎙️  Live Turn #${m.turnIndex} | ${m.inputMode} | TTFA:${m.ttfa_ms}ms TOTAL:${m.totalResponse_ms}ms | chunks:${m.audioChunksReceived}${tok}${turnDetail}`
  );
  saveLiveSessionReport(m.sessionId);
}

// ── Getters ───────────────────────────────────────────────────────

export function getMetrics(sessionId?: string): TurnMetrics[] {
  return sessionId ? (restLogs[sessionId] ?? []) : Object.values(restLogs).flat();
}

export function getSummary(sessionId?: string) {
  const log = getMetrics(sessionId);
  if (!log.length) return null;
  const avg = (a: number[]) => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
  const vt = log.filter(t => t.inputMode === "voice");
  return {
    total_turns: log.length,
    voice_turns: vt.length,
    text_turns: log.length - vt.length,
    avg_stt_ms: avg(vt.map(t => t.latency.stt_ms)),
    avg_llm_ms: avg(log.map(t => t.latency.llm_ms)),
    avg_tts_ms: avg(log.map(t => t.latency.tts_ms)),
    avg_total_ms: avg(log.map(t => t.latency.total_ms)),
    avg_quality: +(log.reduce((a, t) => a + t.responseQualityScore, 0) / log.length).toFixed(2),
    min_total_ms: Math.min(...log.map(t => t.latency.total_ms)),
    max_total_ms: Math.max(...log.map(t => t.latency.total_ms)),
  };
}

// ── Markdown helpers ──────────────────────────────────────────────

const badge = (ms: number) => ms < 500 ? "🟢" : ms < 1200 ? "🟡" : "🔴";
const bar   = (n: number, max = 10) => "█".repeat(n) + "░".repeat(max - n);
const slug  = (id: string) => id.slice(0, 8);

// ── REST session report ───────────────────────────────────────────

export function saveSessionReport(sessionId: string): void {
  ensureDir();
  const turns = restLogs[sessionId];
  if (!turns?.length) return;

  const s      = getSummary(sessionId)!;
  const date   = turns[0].timestamp.slice(0, 10);
  const time   = turns[0].timestamp.slice(11, 19).replace(/:/g, "-");
  const file   = path.join(LOGS_DIR, `rest-${slug(sessionId)}-${date}-${time}.md`);

  const lines = [
    `# IPL 2026 FAQ Bot — REST Session Report`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Session ID | \`${sessionId}\` |`,
    `| Date | ${date} |`,
    `| Turns | ${s.total_turns} (voice: ${s.voice_turns}, text: ${s.text_turns}) |`,
    `| Generated | ${new Date().toISOString()} |`,
    ``,
    `## Latency Summary`,
    ``,
    `| Metric | Value | Rating |`,
    `|--------|-------|--------|`,
    `| Avg STT | ${s.avg_stt_ms} ms | ${badge(s.avg_stt_ms)} |`,
    `| Avg LLM | ${s.avg_llm_ms} ms | ${badge(s.avg_llm_ms)} |`,
    `| Avg TTS | ${s.avg_tts_ms} ms | ${badge(s.avg_tts_ms)} |`,
    `| Avg Round-Trip | ${s.avg_total_ms} ms | ${badge(s.avg_total_ms)} |`,
    `| Min / Max | ${s.min_total_ms} ms / ${s.max_total_ms} ms | — |`,
    `| Avg Response Quality | **${s.avg_quality}/10** | \`${bar(Math.round(s.avg_quality))}\` |`,
    ``,
    `> 🟢 <500 ms   🟡 500–1200 ms   🔴 >1200 ms`,
    ``,
    `## Turn-by-Turn`,
    ``,
  ];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    lines.push(
      `### Turn ${i + 1} — ${t.timestamp}`,
      ``,
      `| | |`,
      `|--|--|`,
      `| Input | ${t.inputMode === "voice" ? "🎤 Voice" : "⌨️ Text"} |`,
      `| User | ${t.transcript} |`,
      `| Bot | ${t.geminiResponse} |`,
      `| STT / LLM / TTS | ${t.latency.stt_ms} / ${t.latency.llm_ms} / ${t.latency.tts_ms} ms |`,
      `| Round-Trip | **${t.latency.total_ms} ms** ${badge(t.latency.total_ms)} |`,
      `| Transcript Accuracy | ${t.transcriptAccuracyNote} |`,
      `| Response Quality | **${t.responseQualityScore}/10** \`${bar(t.responseQualityScore)}\` — ${t.responseQualityNote} |`,
      ``,
      `---`,
      ``,
    );
  }

  fs.writeFileSync(file, lines.join("\n"), "utf8");
  console.log(`[Metrics] REST report → logs/${path.basename(file)}`);
}

// ── Live session report ───────────────────────────────────────────

export function saveLiveSessionReport(sessionId: string): void {
  ensureDir();
  const turns = liveLogs[sessionId];
  if (!turns?.length) return;

  const date  = turns[0].timestamp.slice(0, 10);
  const time  = turns[0].timestamp.slice(11, 19).replace(/:/g, "-");
  const file  = path.join(LOGS_DIR, `live-${slug(sessionId)}-${date}-${time}.md`);

  const avgTTFA  = Math.round(turns.reduce((a, t) => a + t.ttfa_ms, 0) / turns.length);
  const avgTotal = Math.round(turns.reduce((a, t) => a + t.totalResponse_ms, 0) / turns.length);
  const minTotal = Math.min(...turns.map(t => t.totalResponse_ms));
  const maxTotal = Math.max(...turns.map(t => t.totalResponse_ms));

  const lastTurn     = turns[turns.length - 1];
  const sessionTok   = lastTurn?.usageSessionTotalAfterTurn;
  const summedParts  = turns.reduce(
    (a, t) =>
      a + (t.usagePromptTokens ?? 0) + (t.usageResponseTokens ?? 0) + (t.usageThoughtsTokens ?? 0),
    0
  );
  const tokenSummary =
    sessionTok != null && sessionTok > 0
      ? `**${sessionTok}** (from API \`totalTokenCount\` when reported; else sum of prompt+response+thoughts per turn ≈ **${summedParts}**)`
      : summedParts > 0
        ? `**${summedParts}** (sum of prompt + response + thoughts across turns; API did not report \`totalTokenCount\`)`
        : `*(no \`usageMetadata\` received — model or API may omit counts for this session)*`;

  const lines = [
    `# IPL 2026 FAQ Bot — Live API Session Report`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| Session ID | \`${sessionId}\` |`,
    `| Mode | 🎙️ Gemini 2.5 Flash Native Audio (Live API) |`,
    `| Date | ${date} |`,
    `| Turns | ${turns.length} |`,
    `| Est. session tokens (end) | ${tokenSummary} |`,
    `| Generated | ${new Date().toISOString()} |`,
    ``,
    `> Token counts come from Live API \`usageMetadata\` when present. They do **not** include separate REST calls (e.g. English caption \`gemini-2.0-flash\`). Free-tier remaining quota is shown in [Google AI Studio](https://aistudio.google.com/), not in this log.`,
    ``,
    `## Live API Performance Summary`,
    ``,
    `| Metric | Value | Rating |`,
    `|--------|-------|--------|`,
    `| Avg Time-to-First-Audio (TTFA) | ${avgTTFA} ms | ${badge(avgTTFA)} |`,
    `| Avg Total Response Time | ${avgTotal} ms | ${badge(avgTotal)} |`,
    `| Min / Max Response Time | ${minTotal} ms / ${maxTotal} ms | — |`,
    ``,
    `> **TTFA** = time from first user audio sent → first Gemini audio chunk received.`,
    `> No separate STT / LLM / TTS breakdown — pipeline is end-to-end native audio.`,
    ``,
    `> 🟢 <500 ms   🟡 500–1200 ms   🔴 >1200 ms`,
    ``,
    `## Turn-by-Turn`,
    ``,
  ];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    lines.push(
      `### Turn ${i + 1} — ${t.timestamp}`,
      ``,
      `| | |`,
      `|--|--|`,
      `| Input | ${t.inputMode === "live-voice" ? "🎤 Live Voice" : "⌨️ Live Text"} |`,
      `| User transcript | ${t.userTranscript || "*(not captured — native audio VAD path)*"} |`,
      `| Bot response text | ${t.botResponseText || "*(audio only)*"} |`,
      `| Time to First Audio | **${t.ttfa_ms} ms** ${badge(t.ttfa_ms)} |`,
      `| Total Response Time | **${t.totalResponse_ms} ms** ${badge(t.totalResponse_ms)} |`,
      `| Audio Chunks Received | ${t.audioChunksReceived} |`,
      `| Tokens (this turn: prompt / response / thoughts) | ${t.usagePromptTokens ?? "—"} / ${t.usageResponseTokens ?? "—"} / ${t.usageThoughtsTokens ?? "—"} |`,
      `| Session tokens after turn | ${t.usageSessionTotalAfterTurn ?? "—"} |`,
      ``,
      `---`,
      ``,
    );
  }

  fs.writeFileSync(file, lines.join("\n"), "utf8");

  appendLiveTokenUsageJsonl({
    sessionId,
    turnCount: turns.length,
    usageSessionTotalAfterLastTurn:
      lastTurn?.usageSessionTotalAfterTurn ?? null,
    summedPromptResponseThoughts: summedParts,
  });

  const tokDisplay =
    sessionTok != null && sessionTok > 0
      ? `session tokens≈${sessionTok}`
      : summedParts > 0
        ? `summed prompt/response/thoughts=${summedParts}`
        : "no usageMetadata from API this snapshot";
  console.log(
    `[Metrics] Live → logs/${path.basename(file)}  |  ${tokDisplay}  |  append logs/token-usage.jsonl`
  );
}
