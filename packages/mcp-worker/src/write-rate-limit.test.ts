import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { assertMcpWriteWithinRateLimit } from "./write-rate-limit.js";

describe("assertMcpWriteWithinRateLimit", () => {
  it("allows writes up to the per-grant window cap", async () => {
    const grantId = `grant-${Math.random()}`;
    for (let i = 0; i < 30; i++) {
      expect(await assertMcpWriteWithinRateLimit(env, grantId)).toEqual({ ok: true });
    }
    expect(await assertMcpWriteWithinRateLimit(env, grantId)).toEqual({ ok: false });
  });
});
