/** Build-time App Version. Vite `define` injects this as `__APP_VERSION__`. */

export const LOCAL_APP_VERSION = "local-dev";
const SHORT_SHA_LENGTH = 7;

/** Production: first 7 chars of the checked-out deploy SHA. Local: `local-dev`. */
export function resolveAppVersion(env: Record<string, string | undefined> = process.env) {
  const sha = env.APP_RELEASE_SHA?.trim();
  if (!sha) {
    return LOCAL_APP_VERSION;
  }
  return sha.slice(0, SHORT_SHA_LENGTH);
}
