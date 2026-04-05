// src/gemini-errors.ts — user-safe messages for Gemini / Google API failures (no secrets)

export interface GeminiUserError {
  message: string;
  /** Stable code for clients (e.g. show setup instructions) */
  code?: string;
}

/**
 * Map SDK / HTTP errors to short UI + optional machine code.
 * Never include API keys or raw upstream payloads.
 */
export function formatGeminiUserError(err: unknown): GeminiUserError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (
    /gemini_api_key is not set|gemini_api_key not set|not set in \.env|no gemini api key/i.test(
      raw
    )
  ) {
    return {
      message:
        "Server is missing a Gemini API key. In Railway → Variables set GEMINI_API_KEY (or GOOGLE_API_KEY).",
      code: "GEMINI_API_KEY",
    };
  }

  // Before 403: Google formats many errors as "[403 Forbidden] …" — do not treat "Forbidden" alone as "leaked key".
  if (
    /429/.test(raw) ||
    /too many requests|exceeded your current quota|resource_exhausted|rate limit/i.test(lower)
  ) {
    return {
      message:
        "Gemini rate limit or quota exceeded (429). Wait a few minutes, try again later, or check plan and quotas: https://ai.google.dev/gemini-api/docs/rate-limits",
      code: "GEMINI_QUOTA",
    };
  }

  if (
    /403/.test(raw) &&
    /reported as leaked|was leaked|invalid api key|api key invalid|api key not valid|incorrect api key|wrong api key/i.test(
      raw
    )
  ) {
    return {
      message:
        "Gemini rejected the API key (invalid, revoked, or reported as leaked). Create a **new** key in Google AI Studio and update GEMINI_API_KEY in Railway Variables — do not reuse a key that was ever committed or pasted publicly.",
      code: "GEMINI_API_KEY",
    };
  }

  if (/401/.test(raw) || /unauthorized/i.test(lower)) {
    return {
      message: "Gemini returned Unauthorized — GEMINI_API_KEY is wrong or expired.",
      code: "GEMINI_API_KEY",
    };
  }

  if (/403/.test(raw) || /\bforbidden\b/i.test(lower)) {
    return {
      message:
        "Gemini returned Forbidden — check the API key, billing, and that the model is enabled for your project.",
      code: "GEMINI_FORBIDDEN",
    };
  }

  const msg = raw.length > 320 ? `${raw.slice(0, 317)}…` : raw;
  return { message: msg, code: "GEMINI_ERROR" };
}
