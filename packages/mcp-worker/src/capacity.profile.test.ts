import { MCP_JSON_MAX_BODY_BYTES } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import { assertClonedBodyWithinLimit } from "./bounded-body.js";
import {
  authenticatedRateLimitKey,
  toolClassOf,
  unauthenticatedRateLimitKey,
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

describe("capacity profile", () => {
  it("keeps local body-limit + rate-limit key work well under the 10ms Workers Free CPU budget", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: i % 2 === 0 ? "get_circle" : "archive_transaction" },
      });
      const request = new Request("https://mcp.pocketcircle.app/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const started = performance.now();
      expect(await assertClonedBodyWithinLimit(request, MCP_JSON_MAX_BODY_BYTES)).toBe(true);
      authenticatedRateLimitKey({
        userId: `user-${i}`,
        clientId: `client-${i % 3}`,
        grantId: `grant-${i % 5}`,
        toolClass: toolClassOf(i % 2 === 0 ? "get_circle" : "archive_transaction") ?? "read",
      });
      unauthenticatedRateLimitKey({
        className: "authorization",
        clientId: `client-${i % 3}`,
        ip: "203.0.113.10",
      });
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
    expect(p95).toBeLessThan(5);
  });
});
