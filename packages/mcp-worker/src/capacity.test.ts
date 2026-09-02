import { describe, expect, it } from "vitest";
import {
  authenticatedRateLimitKey,
  toolClassOf,
  unauthenticatedRateLimitKey,
} from "./rate-limit.js";
import { mcpLog, scrubMcpLogRecord, scrubMcpLogText } from "./safe-log.js";
import { MCP_SERVER_INSTRUCTIONS } from "./server-instructions.js";

describe("rate-limit keys", () => {
  it("builds authenticated keys from user, client, grant, and tool class", () => {
    expect(
      authenticatedRateLimitKey({
        userId: "user-1",
        clientId: "client-1",
        grantId: "grant-1",
        toolClass: "destructive",
      }),
    ).toBe("u:user-1|c:client-1|g:grant-1|t:destructive");
  });

  it("prefers client over IP for unauthenticated classes", () => {
    expect(
      unauthenticatedRateLimitKey({
        className: "authorization",
        clientId: "client-1",
        ip: "1.2.3.4",
      }),
    ).toBe("authorization|c:client-1");
    expect(
      unauthenticatedRateLimitKey({
        className: "failed_auth",
        ip: "1.2.3.4",
      }),
    ).toBe("failed_auth|ip:1.2.3.4");
  });

  it("classifies archive tools as destructive", () => {
    expect(toolClassOf("archive_transaction")).toBe("destructive");
    expect(toolClassOf("create_transaction")).toBe("write");
    expect(toolClassOf("get_circle")).toBe("read");
  });
});

describe("safe-log scrubbing", () => {
  it("redacts bearer tokens, JWT-shaped strings, and emails from free text", () => {
    const scrubbed = scrubMcpLogText(
      "Bearer secret-token eyJhbGciOiJIUzI1NiJ9.payload user@example.com",
    );
    expect(scrubbed).not.toContain("secret-token");
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(scrubbed).not.toContain("user@example.com");
    expect(scrubbed).toContain("[redacted]");
  });

  it("drops forbidden financial and credential keys", () => {
    const scrubbed = scrubMcpLogRecord({
      event: "mcp_request",
      title: "Coffee",
      note: "secret note",
      amountMinorUnits: 500,
      email: "a@b.co",
      name: "Family Circle",
      token: "access-token",
      assertion: "signed.jwt",
      status: 200,
      durationMs: 4,
    });
    expect(scrubbed).toEqual({
      event: "mcp_request",
      status: 200,
      durationMs: 4,
    });
  });

  it("mcpLog never emits representative sensitive payloads", () => {
    const lines: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args[0]);
    };
    try {
      mcpLog({
        event: "mcp_request",
        outcome: "ok",
        status: 200,
        toolClass: "write",
        durationMs: 3.2,
        errorCode: "Bearer leak-token user@example.com",
      });
    } finally {
      console.log = original;
    }
    const serialized = String(lines[0]);
    expect(serialized).not.toContain("leak-token");
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("Coffee");
    expect(serialized).not.toContain("amountMinorUnits");
  });
});

describe("server instructions", () => {
  it("tells clients stored fields are untrusted typed data", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain("untrusted user data");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("structuredContent");
    expect(MCP_SERVER_INSTRUCTIONS).not.toMatch(/\$\{/);
  });
});
