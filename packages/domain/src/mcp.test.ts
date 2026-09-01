import { describe, expect, it } from "vitest";
import {
  isMcpScope,
  mcpCircleViewSchema,
  mcpCurrentUserViewSchema,
  mcpMemberViewSchema,
  mcpOperationBodySchema,
  mcpScopesInclude,
  normalizeMcpImage,
  normalizeMcpScopes,
} from "./mcp.js";
import { personalCircleName } from "./personal-circle-name.js";
import { LIMITS } from "./validation.js";

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
    expect(normalizeMcpImage("x".repeat(2049))).toBeNull();
    expect(
      mcpCurrentUserViewSchema.safeParse({
        id: "u123",
        displayName: "Alice",
        image: "x".repeat(2049),
        createdAt: 123456789,
      }).success,
    ).toBe(false);
    expect(
      mcpMemberViewSchema.safeParse({
        id: "m123",
        displayName: "Alice",
        image: "x".repeat(2049),
        role: "member",
        status: "active",
        joinedAt: 123456789,
        isSelf: false,
      }).success,
    ).toBe(false);
  });

  it("validates mcpCircleViewSchema", () => {
    const circle = {
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
    };
    expect(mcpCircleViewSchema.safeParse(circle).success).toBe(true);

    const longPersonalName = personalCircleName("x".repeat(LIMITS.displayNameMax));
    expect(longPersonalName).toHaveLength(LIMITS.displayNameMax + "'s Circle".length);
    expect(mcpCircleViewSchema.safeParse({ ...circle, name: longPersonalName }).success).toBe(true);
    expect(mcpCircleViewSchema.safeParse({ ...circle, name: `${longPersonalName}x` }).success).toBe(
      false,
    );
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

    const searchOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "search_transactions",
        circleRef: "trip-c123",
        filters: { status: "all", query: "coffee" },
        page: 1,
      },
    });
    expect(searchOp.success).toBe(true);

    const mixedPagination = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "search_transactions",
        circleRef: "trip-c123",
        page: 2,
        paginationOpts: { numItems: 10, cursor: null },
      },
    });
    expect(mixedPagination.success).toBe(false);

    const mixedDateWindows = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "search_transactions",
        circleRef: "trip-c123",
        filters: { month: "2026-06", dateFrom: "2026-06-01" },
      },
    });
    expect(mixedDateWindows.success).toBe(false);

    const longSearchQuery = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "search_transactions",
        circleRef: "trip-c123",
        filters: { query: "x".repeat(200) },
      },
    });
    expect(longSearchQuery.success).toBe(true);

    const ledgerOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "get_monthly_ledger",
        circleRef: "trip-c123",
        month: "2026-06",
      },
    });
    expect(ledgerOp.success).toBe(true);

    const comparisonOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "get_monthly_comparison",
        circleRef: "trip-c123",
        rangeMonths: 6,
      },
    });
    expect(comparisonOp.success).toBe(true);

    const invalidComparisonRange = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "get_monthly_comparison",
        circleRef: "trip-c123",
        rangeMonths: 2,
      },
    });
    expect(invalidComparisonRange.success).toBe(false);
  });
});
