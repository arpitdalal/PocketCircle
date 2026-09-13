/** Push-service HTTP outcome classification (#382) — shared by Node sender + tests. */

/**
 * 404/410 → prune without retry.
 * Other 4xx (except 408/429) → fail closed without retry or prune.
 * Else → Workpool retry.
 */
export function classifyPushHttpStatus(statusCode: number) {
  if (statusCode === 404 || statusCode === 410) {
    return "gone" as const;
  }
  if (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
    return "permanent" as const;
  }
  return "transient" as const;
}

export function pushHttpStatusFromError(error: unknown) {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const { statusCode } = error;
  return typeof statusCode === "number" ? statusCode : undefined;
}
