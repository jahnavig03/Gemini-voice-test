/**
 * Resolve Gemini API key from environment.
 * Precedence: GEMINI_API_KEY, then common alternates some hosts use.
 * If you set a new key under GOOGLE_API_KEY only, clear or fix GEMINI_API_KEY
 * so the old leaked value is not still taking precedence.
 */
export function getGeminiApiKey(): string {
  const k =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.GOOGLE_AI_API_KEY?.trim();
  if (!k) {
    throw new Error(
      "No Gemini API key: set GEMINI_API_KEY (or GOOGLE_API_KEY) in the host environment."
    );
  }
  return k;
}
