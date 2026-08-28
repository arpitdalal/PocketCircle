import { describe, expect, it } from "vitest";
import {
  MCP_RESOURCE_URI,
  type McpApprovalPayload,
  type McpHandoffPayload,
  type McpWorkerAssertionPayload,
  sha256Hex,
  signMcpApproval,
  signMcpHandoff,
  signMcpWorkerAssertion,
  verifyMcpApproval,
  verifyMcpHandoff,
  verifyMcpWorkerAssertion,
} from "./mcp-oauth.js";

const SECRET = "test-shared-secret";

function handoffPayload(overrides: Partial<McpHandoffPayload> = {}): McpHandoffPayload {
  return {
    v: 1,
    handoffId: "handoff-1",
    clientId: "https://client.example/client.json",
    clientKind: "cimd",
    redirectUri: "https://client.example/callback",
    resource: MCP_RESOURCE_URI,
    scopes: ["pocketcircle:read", "pocketcircle:write"],
    clientName: "Example Client",
    iat: Date.now(),
    exp: Date.now() + 60_000,
    ...overrides,
  };
}

function assertionPayload(
  overrides: Partial<McpWorkerAssertionPayload> = {},
): McpWorkerAssertionPayload {
  return {
    aud: "pocketcircle:mcp-worker",
    method: "POST",
    path: "/mcp/redeem-approval",
    bodySha256: "deadbeef",
    iat: Date.now(),
    exp: Date.now() + 60_000,
    nonce: "nonce-1",
    ...overrides,
  };
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

describe("MCP Worker assertion sign/verify", () => {
  it("round-trips a valid payload", async () => {
    const payload = assertionPayload();
    const token = await signMcpWorkerAssertion(payload, SECRET);
    const verified = await verifyMcpWorkerAssertion(token, SECRET);
    expect(verified).toEqual(payload);
  });

  it("rejects expiry", async () => {
    const token = await signMcpWorkerAssertion(assertionPayload({ exp: Date.now() - 1 }), SECRET);
    expect(await verifyMcpWorkerAssertion(token, SECRET)).toBeNull();
  });

  it("rejects the wrong secret", async () => {
    const token = await signMcpWorkerAssertion(assertionPayload(), SECRET);
    expect(await verifyMcpWorkerAssertion(token, "wrong-secret")).toBeNull();
  });

  it("rejects a wrong audience", async () => {
    const token = await signMcpWorkerAssertion(
      // @ts-expect-error intentionally invalid payload for the negative test
      { ...assertionPayload(), aud: "someone-else" },
      SECRET,
    );
    expect(await verifyMcpWorkerAssertion(token, SECRET)).toBeNull();
  });
});

describe("MCP approval sign/verify", () => {
  function approvalPayload(overrides: Partial<McpApprovalPayload> = {}): McpApprovalPayload {
    const now = Date.now();
    return {
      v: 1,
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
    };
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
