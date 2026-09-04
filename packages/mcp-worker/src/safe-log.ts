import type { McpRateLimitClass } from "./rate-limit.js";

/**
 * Operational logging for the MCP Worker (#331).
 * Never logs tokens, codes, assertions, amounts, titles, notes, circle names, or emails.
 */

const FORBIDDEN_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "code",
  "assertion",
  "handoff",
  "handoffid",
  "approvaltoken",
  "revocationtoken",
  "bearer",
  "password",
  "secret",
  "amount",
  "amountminorunits",
  "title",
  "note",
  "email",
  "displayname",
  "circlename",
  "name",
]);

const SENSITIVE_VALUE_RE =
  /Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export type McpLogFields = {
  event: string;
  outcome?: "ok" | "error" | "rate_limited" | "rejected";
  status?: number;
  toolClass?: McpRateLimitClass;
  durationMs?: number;
  errorCode?: string;
};

function keyLooksForbidden(key: string) {
  return FORBIDDEN_KEYS.has(key.toLowerCase());
}

/** Scrub free-form strings before they touch any log sink. */
export function scrubMcpLogText(value: string) {
  return value.replace(SENSITIVE_VALUE_RE, "[redacted]").slice(0, 200);
}

/**
 * Drops forbidden keys and scrubs remaining string values. Used by tests and
 * any accidental spread of richer objects into log sinks.
 */
export function scrubMcpLogRecord(record: Record<string, unknown>) {
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keyLooksForbidden(key)) {
      continue;
    }
    if (typeof value === "string") {
      scrubbed[key] = scrubMcpLogText(value);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      scrubbed[key] = value;
    } else if (Array.isArray(value)) {
      scrubbed[key] = `[array:${value.length}]`;
    } else if (typeof value === "object") {
      scrubbed[key] = "[object]";
    }
  }
  return scrubbed;
}

/** Structured operational log — only allowlisted fields. */
export function mcpLog(fields: McpLogFields) {
  console.log(
    JSON.stringify({
      source: "mcp-worker",
      event: fields.event,
      ...(fields.outcome ? { outcome: fields.outcome } : {}),
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      ...(fields.toolClass ? { toolClass: fields.toolClass } : {}),
      ...(fields.durationMs !== undefined ? { durationMs: Math.round(fields.durationMs) } : {}),
      ...(fields.errorCode ? { errorCode: scrubMcpLogText(fields.errorCode) } : {}),
    }),
  );
}

export function mcpLogError(event: string, errorCode?: string) {
  console.error(
    JSON.stringify({
      source: "mcp-worker",
      event,
      outcome: "error",
      ...(errorCode ? { errorCode: scrubMcpLogText(errorCode) } : {}),
    }),
  );
}
