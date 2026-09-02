import { MCP_JSON_MAX_BODY_BYTES, sha256Hex, utf8ByteLength } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import { assertClonedBodyWithinLimit } from "./bounded-body.js";
import {
  authenticatedRateLimitMaterial,
  toolClassOf,
  unauthenticatedRateLimitMaterial,
} from "./rate-limit.js";

/**
 * Local wall-time micro-bench for the capacity-critical Worker path (#331).
 * Reports p50/p95 so capacity docs have a reproducible local baseline.
 * Production Worker CPU must still be measured in the Cloudflare dashboard.
 */
function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function nearLimitJsonRpcBody(id: number, toolName: string) {
  const withPad = (pad: string) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: { pad } },
    });
  // Stay just under the configured ceiling so assertClonedBodyWithinLimit still accepts.
  const padBytes = Math.max(0, MCP_JSON_MAX_BODY_BYTES - utf8ByteLength(withPad("")) - 8);
  return withPad("x".repeat(padBytes));
}

describe("capacity profile", () => {
  it("reports local body-limit + rate-limit key timing (informational, not a CI gate)", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const toolName = i % 2 === 0 ? "get_circle" : "archive_transaction";
      const toolClass = toolClassOf(toolName);
      if (toolClass === null) {
        throw new Error(`missing tool class for ${toolName}`);
      }
      expect(toolClass).toBe(i % 2 === 0 ? "read" : "destructive");

      const body = nearLimitJsonRpcBody(i, toolName);
      expect(utf8ByteLength(body)).toBeLessThanOrEqual(MCP_JSON_MAX_BODY_BYTES);
      expect(utf8ByteLength(body)).toBeGreaterThan(MCP_JSON_MAX_BODY_BYTES - 64);

      const request = new Request("https://mcp.pocketcircle.app/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const started = performance.now();
      expect(await assertClonedBodyWithinLimit(request, MCP_JSON_MAX_BODY_BYTES)).toBe(true);
      // Match production: hash materials before limit() (64-byte CF key cap).
      await sha256Hex(
        authenticatedRateLimitMaterial({
          userId: `user-${i}`,
          clientId: `client-${i % 3}`,
          grantId: `grant-${i % 5}`,
          toolClass,
        }),
      );
      await sha256Hex(
        unauthenticatedRateLimitMaterial({
          className: "authorization",
          clientId: `client-${i % 3}`,
          ip: "203.0.113.10",
        }),
      );
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    console.log(
      JSON.stringify({
        source: "mcp-capacity-profile",
        samples: samples.length,
        p50Ms: Number(p50.toFixed(4)),
        p95Ms: Number(p95.toFixed(4)),
        workersFreeCpuMs: 10,
      }),
    );
    // Reporting only — absolute wall-clock gates flake on shared CI hosts.
    expect(samples.length).toBe(200);
    expect(p50).toBeGreaterThanOrEqual(0);
    expect(p95).toBeGreaterThanOrEqual(p50);
  });
});
