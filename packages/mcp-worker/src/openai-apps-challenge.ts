/**
 * OpenAI plugin portal domain verification.
 * Serves only the challenge token as plain text (no JSON/HTML).
 * https://developers.openai.com/plugins/deploy/submission#domain-verification
 */
export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

export function openaiAppsChallengeResponse(token: string | undefined) {
  const value = token?.trim();
  if (!value) {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return new Response(value, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
