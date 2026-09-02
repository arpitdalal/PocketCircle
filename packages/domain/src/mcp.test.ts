import { describe, expect, it } from "vitest";
import {
  isMcpScope,
  mcpCircleViewSchema,
  mcpCreateTransactionInputSchema,
  mcpCurrentUserViewSchema,
  mcpMemberViewSchema,
  mcpOperationBodySchema,
  mcpScopesInclude,
  mcpUpdateCategoryInputSchema,
  mcpUpdateTransactionInputSchema,
  mcpWriteOperationBodySchema,
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
        endMonth: "2026-06",
        rangeMonths: 6,
      },
    });
    expect(comparisonOp.success).toBe(true);

    const dashboardWithoutMonth = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "get_dashboard",
        circleRef: "trip-c123",
      },
    });
    expect(dashboardWithoutMonth.success).toBe(false);

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

    const listCategoriesOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "list_categories",
        circleRef: "trip-c123",
        filters: { type: "expense", status: "archived", query: "gas" },
      },
    });
    expect(listCategoriesOp.success).toBe(true);

    const categoryDetailOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "get_category",
        circleRef: "trip-c123",
        categoryRef: "groceries-cat1",
      },
    });
    expect(categoryDetailOp.success).toBe(true);

    const categoryTransactionsOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "list_category_transactions",
        circleRef: "trip-c123",
        categoryRef: "groceries-cat1",
      },
    });
    expect(categoryTransactionsOp.success).toBe(true);

    const categoryHistoryOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:read"],
      operation: {
        kind: "list_category_history",
        circleRef: "trip-c123",
        categoryRef: "groceries-cat1",
      },
    });
    expect(categoryHistoryOp.success).toBe(true);

    const createTransactionOp = mcpOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:write"],
      operation: {
        kind: "create_transaction",
        circleRef: "trip-c123",
        type: "expense",
        title: "Coffee",
        amountMinorUnits: 500,
        date: "2026-06-01",
        categoryRefs: ["groceries-cat1"],
        expectedCurrency: "USD",
      },
    });
    expect(createTransactionOp.success).toBe(true);
  });

  it("validates mcpWriteOperationBodySchema for create_transaction", () => {
    const valid = mcpWriteOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:write"],
      operation: {
        kind: "create_transaction",
        circleRef: "trip-c123",
        type: "expense",
        title: "Coffee",
        amountMinorUnits: 500,
        date: "2026-06-01",
        categoryRefs: ["groceries-cat1"],
        expectedCurrency: "USD",
      },
    });
    expect(valid.success).toBe(true);

    const duplicateCategories = mcpCreateTransactionInputSchema.safeParse({
      circleRef: "trip-c123",
      type: "expense",
      title: "Coffee",
      amountMinorUnits: 500,
      date: "2026-06-01",
      categoryRefs: ["groceries-cat1", "groceries-cat1"],
      expectedCurrency: "USD",
    });
    expect(duplicateCategories.success).toBe(false);

    const tooManyCategories = mcpCreateTransactionInputSchema.safeParse({
      circleRef: "trip-c123",
      type: "expense",
      title: "Coffee",
      amountMinorUnits: 500,
      date: "2026-06-01",
      categoryRefs: Array.from(
        { length: LIMITS.maxCategoriesPerTransaction + 1 },
        (_, index) => `cat-${index}`,
      ),
      expectedCurrency: "USD",
    });
    expect(tooManyCategories.success).toBe(false);
  });

  it("validates mcpWriteOperationBodySchema for update_transaction", () => {
    const valid = mcpWriteOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:write"],
      operation: {
        kind: "update_transaction",
        circleRef: "trip-c123",
        transactionRef: "coffee-txn1",
        title: "Updated coffee",
      },
    });
    expect(valid.success).toBe(true);

    const emptyUpdate = mcpUpdateTransactionInputSchema.safeParse({
      circleRef: "trip-c123",
      transactionRef: "coffee-txn1",
    });
    expect(emptyUpdate.success).toBe(false);

    const amountWithoutCurrency = mcpUpdateTransactionInputSchema.safeParse({
      circleRef: "trip-c123",
      transactionRef: "coffee-txn1",
      amountMinorUnits: 500,
    });
    expect(amountWithoutCurrency.success).toBe(false);
  });

  it("validates mcpWriteOperationBodySchema for archive_transaction and restore_transaction", () => {
    const archive = mcpWriteOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:write"],
      operation: {
        kind: "archive_transaction",
        circleRef: "trip-c123",
        transactionRef: "coffee-txn1",
      },
    });
    expect(archive.success).toBe(true);

    const restore = mcpWriteOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:write"],
      operation: {
        kind: "restore_transaction",
        circleRef: "trip-c123",
        transactionRef: "coffee-txn1",
      },
    });
    expect(restore.success).toBe(true);
  });

  it("validates mcpWriteOperationBodySchema for create_category and update_category", () => {
    const createCategory = mcpWriteOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:write"],
      operation: {
        kind: "create_category",
        circleRef: "trip-c123",
        name: "Coffee",
        type: "expense",
        color: "teal",
      },
    });
    expect(createCategory.success).toBe(true);

    const updateCategory = mcpWriteOperationBodySchema.safeParse({
      grantId: "g123",
      effectiveScopes: ["pocketcircle:write"],
      operation: {
        kind: "update_category",
        circleRef: "trip-c123",
        categoryRef: "coffee-cat1",
        name: "Updated coffee",
      },
    });
    expect(updateCategory.success).toBe(true);

    const emptyUpdate = mcpUpdateCategoryInputSchema.safeParse({
      circleRef: "trip-c123",
      categoryRef: "coffee-cat1",
    });
    expect(emptyUpdate.success).toBe(false);
  });
});
