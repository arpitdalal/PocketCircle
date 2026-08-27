import { describe, expect, it } from "vitest";
import { generateInvitationToken, hashInvitationToken } from "./invitationToken.js";
import { generateOpaqueToken } from "./opaqueToken.js";

describe("generateOpaqueToken", () => {
  it("generates unique URL-safe tokens", () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[+/=]/);
  });
});

describe("invitationToken", () => {
  it("uses the shared opaque token generator", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).not.toBe(b);
    expect(a).not.toMatch(/[+/=]/);
  });

  it("hashes deterministically for a given token", async () => {
    const token = "test-token-value";
    const hash1 = await hashInvitationToken(token);
    const hash2 = await hashInvitationToken(token);
    expect(hash1).toBe(hash2);
  });

  it("never equals the plaintext token", async () => {
    const token = generateInvitationToken();
    const hash = await hashInvitationToken(token);
    expect(hash).not.toBe(token);
  });
});
