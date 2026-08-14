/** Build-time App Version. Vite `define` injects this as `__APP_VERSION__`. */

export const LOCAL_APP_VERSION = "local-dev";

/** Production: immutable release tag. Local: `local-dev`. */
export function resolveAppVersion(env: Record<string, string | undefined> = process.env) {
  return env.APP_RELEASE_VERSION?.trim() || LOCAL_APP_VERSION;
}

/** Production telemetry: release tag plus exact source revision. */
export function resolveAppRelease(env: Record<string, string | undefined> = process.env) {
  const version = resolveAppVersion(env);
  const sha = env.APP_RELEASE_SHA?.trim();
  return version === LOCAL_APP_VERSION || !sha ? version : `${version}+${sha}`;
}
