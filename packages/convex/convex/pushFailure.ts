/** Push-service HTTP outcome classification (#382) — shared by Node sender + tests. */

/** 404/410 → prune without retry; anything else → Workpool retry. */
export function classifyPushHttpStatus(statusCode: number) {
  if (statusCode === 404 || statusCode === 410) {
    return "gone" as const;
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
