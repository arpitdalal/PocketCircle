import { describe, expect, it } from "vitest";
import {
  isMcpScope,
  mcpCircleViewSchema,
  mcpCurrentUserViewSchema,
  mcpOperationBodySchema,
  mcpScopesInclude,
  normalizeMcpScopes,
} from "./mcp.js";

describe("normalizeMcpScopes", () => {
  it("dedupes, drops unknowns, and keeps stable MCP_SCOPES order", () => {
    expect(
      normalizeMcpScopes([
        "pocketcircle:write",
        "offline_access",
        "pocketcircle:read",
        "pocketcircle:write",
      ]),
    ).toEqual(["pocketcircle:read", "pocketcircle:write"]);
  });

  it("returns null when nothing valid remains", () => {
    expect(normalizeMcpScopes([])).toBeNull();
    expect(normalizeMcpScopes(["offline_access", "openid"])).toBeNull();
  });
});

describe("mcpScopesInclude / isMcpScope", () => {
  it("checks membership without implying write⊃read", () => {
    expect(isMcpScope("pocketcircle:read")).toBe(true);
    expect(isMcpScope("pocketcircle:manage")).toBe(false);
    expect(mcpScopesInclude(["pocketcircle:write"], "pocketcircle:write")).toBe(true);
    expect(mcpScopesInclude(["pocketcircle:write"], "pocketcircle:read")).toBe(false);
    expect(mcpScopesInclude(["pocketcircle:read", "pocketcircle:write"], "pocketcircle:read")).toBe(
      true,
    );
  });
});

describe("MCP schemas", () => {
  it("validates mcpCurrentUserViewSchema", () => {
    const valid = mcpCurrentUserViewSchema.safeParse({
      id: "u123",
      displayName: "Alice",
      image: null,
      createdAt: 123456789,
    });
    expect(valid.success).toBe(true);
  });

  it("validates mcpCircleViewSchema", () => {
    const valid = mcpCircleViewSchema.safeParse({
      id: "c123",
      ref: "my-circle-c123",
      name: "My Circle",
      kind: "personal",
      currency: "USD",
      color: "sage",
      mark: "home",
      status: "active",
      setupComplete: true,
      currencyLocked: true,
      isOwner: true,
    });
    expect(valid.success).toBe(true);
  });

  it("validates mcpOperationBodySchema for read operations", () => {
    const validUserOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: { kind: "get_current_user" },
    });
    expect(validUserOp.success).toBe(true);

    const validCirclesOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: { kind: "list_authorized_circles" },
    });
    expect(validCirclesOp.success).toBe(true);

    const invalidOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: { kind: "unknown_operation" },
    });
    expect(invalidOp.success).toBe(false);
  });
});
