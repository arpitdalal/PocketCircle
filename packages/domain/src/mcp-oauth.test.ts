import { describe, expect, it } from "vitest";
import {
  contentLengthExceeds,
  MCP_JSON_MAX_BODY_BYTES,
  MCP_RESOURCE_URI,
  MCP_REVOCATION_TTL_MS,
  MCP_WORKER_ASSERTION_TTL_MS,
  type McpApprovalPayload,
  type McpHandoffPayload,
  type McpRevocationPayload,
  type McpWorkerAssertionPayload,
  parseMcpWorkerJwks,
  parseMcpWorkerPrivateJwk,
  readBoundedUtf8,
  sha256Hex,
  signMcpApproval,
  signMcpHandoff,
  signMcpRevocation,
  signMcpWorkerAssertion,
  utf8ByteLength,
  verifyMcpApproval,
  verifyMcpHandoff,
  verifyMcpRevocation,
  verifyMcpWorkerAssertion,
} from "./mcp-oauth.js";

const SECRET = "test-shared-secret";
const PRIVATE_JWK_JSON =
  '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"pUT8Qgi_S3CzQeEpsVsOpOWQtHQffFeyQnrDn0Ez_hM","y":"ZJUnZqOxoZZmmnrivG1fFpw7BfeHBEfGGoVA2Y0Q7Vo","crv":"P-256","d":"HQgOJVhMah1F2_TIH_2T3tSXYMUxMCYx_0trUiMrpVI","kid":"test-current","alg":"ES256"}';
const PUBLIC_JWKS_JSON =
  '{"keys":[{"key_ops":["verify"],"ext":true,"kty":"EC","x":"pUT8Qgi_S3CzQeEpsVsOpOWQtHQffFeyQnrDn0Ez_hM","y":"ZJUnZqOxoZZmmnrivG1fFpw7BfeHBEfGGoVA2Y0Q7Vo","crv":"P-256","kid":"test-current","alg":"ES256"}]}';
const OTHER_PUBLIC_JWKS_JSON =
  '{"keys":[{"key_ops":["verify"],"ext":true,"kty":"EC","x":"mTXikdKU_DzF10Is9wCtBKJ1e025uEd33NUAcZB5Yms","y":"UeeNalKrnJ4upxgbI2KJjLpyaL_-u-lCcCyd7mB953A","crv":"P-256","kid":"test-other","alg":"ES256"}]}';

function privateJwk() {
  const parsed = parseMcpWorkerPrivateJwk(PRIVATE_JWK_JSON);
  if (!parsed) throw new Error("invalid test private JWK");
  return parsed;
}

function publicJwks(value: string = PUBLIC_JWKS_JSON) {
  const parsed = parseMcpWorkerJwks(value);
  if (!parsed) throw new Error("invalid test JWKS");
  return parsed;
}

function handoffPayload(overrides: Partial<McpHandoffPayload> = {}) {
  return {
    v: 1 as const,
    handoffId: "handoff-1",
    clientId: "https://client.example/client.json",
    clientKind: "cimd" as const,
    redirectUri: "https://client.example/callback",
    resource: MCP_RESOURCE_URI,
    scopes: ["pocketcircle:read", "pocketcircle:write"],
    clientName: "Example Client",
    iat: Date.now(),
    exp: Date.now() + 60_000,
    ...overrides,
  } satisfies McpHandoffPayload;
}

function assertionPayload(overrides: Partial<McpWorkerAssertionPayload> = {}) {
  const now = Date.now();
  return {
    aud: "pocketcircle:mcp-worker" as const,
    method: "POST" as const,
    path: "/mcp/redeem-approval",
    bodySha256: "0".repeat(64),
    iat: now,
    exp: now + MCP_WORKER_ASSERTION_TTL_MS,
    nonce: "nonce-1",
    ...overrides,
  } satisfies McpWorkerAssertionPayload;
}

function revocationPayload(overrides: Partial<McpRevocationPayload> = {}) {
  const now = Date.now();
  return {
    v: 1 as const,
    jti: "cleanup-1",
    grantId: "grant-1",
    principalId: "principal-1",
    workerGrantId: "worker-grant-1",
    iat: now,
    exp: now + MCP_REVOCATION_TTL_MS,
    ...overrides,
  } satisfies McpRevocationPayload;
}

describe("MCP handoff sign/verify", () => {
  it("round-trips a valid payload", async () => {
    const payload = handoffPayload();
    const token = await signMcpHandoff(payload, SECRET);
    const verified = await verifyMcpHandoff(token, SECRET);
    expect(verified).toEqual(payload);
  });

  it("rejects expiry", async () => {
    const payload = handoffPayload({ exp: Date.now() - 1 });
    const token = await signMcpHandoff(payload, SECRET);
    expect(await verifyMcpHandoff(token, SECRET)).toBeNull();
  });

  it("rejects the wrong secret", async () => {
    const token = await signMcpHandoff(handoffPayload(), SECRET);
    expect(await verifyMcpHandoff(token, "wrong-secret")).toBeNull();
  });

  it("accepts the previous secret during a bounded rotation window", async () => {
    const payload = handoffPayload();
    const token = await signMcpHandoff(payload, SECRET);
    expect(await verifyMcpHandoff(token, ["new-secret", SECRET])).toEqual(payload);
  });

  it("rejects a tampered payload segment", async () => {
    const token = await signMcpHandoff(handoffPayload(), SECRET);
    const [payloadB64, macB64] = token.split(".");
    const tamperedPayload = JSON.stringify(handoffPayload({ scopes: ["pocketcircle:write"] }));
    const tampered = `${btoa(tamperedPayload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${macB64}`;
    expect(tampered).not.toBe(`${payloadB64}.${macB64}`);
    expect(await verifyMcpHandoff(tampered, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyMcpHandoff("not-a-token", SECRET)).toBeNull();
    expect(await verifyMcpHandoff("", SECRET)).toBeNull();
  });

  it("rejects a payload missing required fields", async () => {
    // Sign an object that is not a valid handoff payload — the schema must reject it.
    const token = await signMcpHandoff(
      // @ts-expect-error intentionally invalid payload for the negative test
      { v: 1, handoffId: "x" },
      SECRET,
    );
    expect(await verifyMcpHandoff(token, SECRET)).toBeNull();
  });
});

describe("MCP revocation capability sign/verify", () => {
  it("round-trips one bounded Worker cleanup capability", async () => {
    const payload = revocationPayload();
    const token = await signMcpRevocation(payload, SECRET);
    expect(await verifyMcpRevocation(token, SECRET)).toEqual(payload);
  });

  it("rejects expiry, tampering, and an overlong lifetime", async () => {
    const now = Date.now();
    const expired = await signMcpRevocation(revocationPayload({ exp: now - 1 }), SECRET);
    expect(await verifyMcpRevocation(expired, SECRET, now)).toBeNull();

    const valid = await signMcpRevocation(revocationPayload(), SECRET);
    const [, macB64] = valid.split(".");
    const tamperedPayload = btoa(
      JSON.stringify(revocationPayload({ workerGrantId: "other-worker-grant" })),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyMcpRevocation(`${tamperedPayload}.${macB64}`, SECRET)).toBeNull();

    const overlong = await signMcpRevocation(
      revocationPayload({ iat: now, exp: now + MCP_REVOCATION_TTL_MS + 1 }),
      SECRET,
    );
    expect(await verifyMcpRevocation(overlong, SECRET, now)).toBeNull();
  });
});

describe("MCP Worker assertion sign/verify", () => {
  it("round-trips a valid payload", async () => {
    const payload = assertionPayload();
    const token = await signMcpWorkerAssertion(payload, privateJwk());
    const verified = await verifyMcpWorkerAssertion(token, publicJwks());
    expect(verified).toEqual(payload);
  });

  it("rejects expiry", async () => {
    const now = Date.now();
    const token = await signMcpWorkerAssertion(
      assertionPayload({ iat: now - 1_000, exp: now - 1 }),
      privateJwk(),
    );
    expect(await verifyMcpWorkerAssertion(token, publicJwks(), now)).toBeNull();
  });

  it("rejects an unknown signing key", async () => {
    const token = await signMcpWorkerAssertion(assertionPayload(), privateJwk());
    expect(await verifyMcpWorkerAssertion(token, publicJwks(OTHER_PUBLIC_JWKS_JSON))).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signMcpWorkerAssertion(assertionPayload(), privateJwk());
    const [headerB64, , signatureB64] = token.split(".");
    const payloadB64 = btoa(JSON.stringify(assertionPayload({ bodySha256: "1".repeat(64) })))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      await verifyMcpWorkerAssertion(`${headerB64}.${payloadB64}.${signatureB64}`, publicJwks()),
    ).toBeNull();
  });

  it("accepts the previous public key during rotation", async () => {
    const payload = assertionPayload();
    const token = await signMcpWorkerAssertion(payload, privateJwk());
    const current = publicJwks(OTHER_PUBLIC_JWKS_JSON).keys[0];
    const previous = publicJwks().keys[0];
    const rotating = parseMcpWorkerJwks(JSON.stringify({ keys: [current, previous] }));
    if (!rotating) throw new Error("invalid rotation JWKS");
    expect(await verifyMcpWorkerAssertion(token, rotating)).toEqual(payload);
  });

  it("rejects future, inverted, and overlong lifetimes", async () => {
    const now = Date.now();
    const badClaims = [
      assertionPayload({
        iat: now + 5_001,
        exp: now + 5_001 + MCP_WORKER_ASSERTION_TTL_MS,
      }),
      assertionPayload({ iat: now, exp: now }),
      assertionPayload({ iat: now, exp: now + MCP_WORKER_ASSERTION_TTL_MS + 1 }),
    ];
    for (const payload of badClaims) {
      const token = await signMcpWorkerAssertion(payload, privateJwk());
      expect(await verifyMcpWorkerAssertion(token, publicJwks(), now)).toBeNull();
    }
  });

  it("accepts /mcp/operation and rejects unknown bridge paths", async () => {
    const validOp = assertionPayload({ path: "/mcp/operation" });
    const validToken = await signMcpWorkerAssertion(validOp, privateJwk());
    expect(await verifyMcpWorkerAssertion(validToken, publicJwks())).toEqual(validOp);

    const invalidPath = { ...assertionPayload(), path: "/mcp/unknown" };
    const invalidToken = await signMcpWorkerAssertion(invalidPath, privateJwk());
    expect(await verifyMcpWorkerAssertion(invalidToken, publicJwks())).toBeNull();
  });

  it("rejects a wrong audience", async () => {
    const token = await signMcpWorkerAssertion(
      // @ts-expect-error intentionally invalid payload for the negative test
      { ...assertionPayload(), aud: "someone-else" },
      privateJwk(),
    );
    expect(await verifyMcpWorkerAssertion(token, publicJwks())).toBeNull();
  });

  it("fails closed on malformed key configuration", () => {
    expect(parseMcpWorkerPrivateJwk("not-json")).toBeNull();
    expect(parseMcpWorkerJwks('{"keys":[]}')).toBeNull();
    const duplicate = publicJwks().keys[0];
    expect(
      parseMcpWorkerJwks(JSON.stringify({ keys: [{ ...duplicate, d: "0".repeat(43) }] })),
    ).toBeNull();
    expect(parseMcpWorkerJwks(JSON.stringify({ keys: [duplicate, duplicate] }))).toBeNull();
  });
});

describe("MCP approval sign/verify", () => {
  function approvalPayload(overrides: Partial<McpApprovalPayload> = {}) {
    const now = Date.now();
    return {
      v: 1 as const,
      jti: "jti-1",
      handoffId: "handoff-1",
      grantId: "grant-1",
      userId: "user-1",
      principalId: "principal-1",
      clientId: "https://client.example/client.json",
      redirectUri: "https://client.example/callback",
      resource: MCP_RESOURCE_URI,
      scopes: ["pocketcircle:read"],
      allowedCircleIds: ["circle-1"],
      iat: now,
      exp: now + 60_000,
      ...overrides,
    } satisfies McpApprovalPayload;
  }

  it("round-trips a valid payload", async () => {
    const payload = approvalPayload();
    const token = await signMcpApproval(payload, SECRET);
    expect(await verifyMcpApproval(token, SECRET)).toEqual(payload);
  });

  it("rejects expiry and wrong secret", async () => {
    const token = await signMcpApproval(approvalPayload({ exp: Date.now() - 1 }), SECRET);
    expect(await verifyMcpApproval(token, SECRET)).toBeNull();
    const live = await signMcpApproval(approvalPayload(), SECRET);
    expect(await verifyMcpApproval(live, "wrong")).toBeNull();
  });

  it("accepts the previous secret during a bounded rotation window", async () => {
    const payload = approvalPayload();
    const token = await signMcpApproval(payload, SECRET);
    expect(await verifyMcpApproval(token, ["new-secret", SECRET])).toEqual(payload);
  });
});

describe("sha256Hex", () => {
  it("is stable and matches a known digest", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("hello")).toBe(await sha256Hex("hello"));
    expect(await sha256Hex("hello")).not.toBe(await sha256Hex("world"));
  });
});

describe("MCP JSON body ceilings", () => {
  it("flags Content-Length above the shared ceiling", () => {
    expect(
      contentLengthExceeds(
        new Headers({ "content-length": String(MCP_JSON_MAX_BODY_BYTES + 1) }),
        MCP_JSON_MAX_BODY_BYTES,
      ),
    ).toBe(true);
    expect(
      contentLengthExceeds(
        new Headers({ "content-length": String(MCP_JSON_MAX_BODY_BYTES) }),
        MCP_JSON_MAX_BODY_BYTES,
      ),
    ).toBe(false);
  });

  it("counts UTF-8 bytes for oversized body checks", () => {
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("x".repeat(MCP_JSON_MAX_BODY_BYTES))).toBe(MCP_JSON_MAX_BODY_BYTES);
  });

  it("stream-limits bodies without Content-Length", async () => {
    const oversized = new Request("https://example.test", {
      method: "POST",
      body: "x".repeat(MCP_JSON_MAX_BODY_BYTES + 1),
    });
    expect(await readBoundedUtf8(oversized, MCP_JSON_MAX_BODY_BYTES)).toBeNull();
    const ok = new Request("https://example.test", {
      method: "POST",
      body: "hello",
    });
    expect(await readBoundedUtf8(ok, MCP_JSON_MAX_BODY_BYTES)).toBe("hello");
  });
});
