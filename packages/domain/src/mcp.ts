import { z } from "zod";
import { isValidMinorUnits } from "./money.js";
import { LIMITS, transactionFieldSchemas } from "./validation.js";

/**
 * MCP grant vocabulary shared by Convex authorization and (later) the Worker
 * bridge. Convex owns the live grant; scopes here are OAuth resource scopes,
 * not app Member/Owner permissions.
 */

export const MCP_SCOPES = ["pocketcircle:read", "pocketcircle:write"] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/** Circle-level app permission an MCP operation may require (existing guard). */
export type McpCirclePermission = "member" | "owner";

const mcpScopeSet = new Set<string>(MCP_SCOPES);

export const MCP_IMAGE_MAX_LENGTH = 2048;

export function normalizeMcpImage(image: string | null | undefined) {
  return image === null || image === undefined || image.length > MCP_IMAGE_MAX_LENGTH
    ? null
    : image;
}

export function isMcpScope(value: string): value is McpScope {
  return mcpScopeSet.has(value);
}

/** Every scope in `required` appears in `granted` (order-independent). */
export function mcpScopesInclude(granted: readonly string[], required: McpScope) {
  return granted.includes(required);
}

/**
 * Normalize a client-supplied scope list: drop unknowns, dedupe, stable order
 * matching {@link MCP_SCOPES}. Empty after filter ⇒ invalid.
 */
export function normalizeMcpScopes(scopes: readonly string[]) {
  const present = new Set<McpScope>();
  for (const scope of scopes) {
    if (isMcpScope(scope)) {
      present.add(scope);
    }
  }
  const normalized = MCP_SCOPES.filter((scope) => present.has(scope));
  return normalized.length > 0 ? normalized : null;
}

export const mcpCurrentUserViewSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  image: z.string().max(MCP_IMAGE_MAX_LENGTH).nullable(),
  createdAt: z.number(),
});

export type McpCurrentUserView = z.infer<typeof mcpCurrentUserViewSchema>;

const mcpCircleNameMax = LIMITS.circleNameMax + "'s Circle".length;

export const mcpCircleViewSchema = z.object({
  id: z.string().min(1).max(128),
  ref: z.string().min(1).max(300),
  name: z.string().min(1).max(mcpCircleNameMax),
  kind: z.enum(["personal", "regular"]),
  currency: z.string().min(1).max(3),
  color: z.string().min(1).max(64),
  mark: z.string().min(1).max(64),
  status: z.enum(["active", "archived"]),
  setupComplete: z.boolean(),
  currencyLocked: z.boolean(),
  isOwner: z.boolean(),
});

export type McpCircleView = z.infer<typeof mcpCircleViewSchema>;

export const mcpMemberViewSchema = z.object({
  id: z.string().min(1).max(128),
  displayName: z.string().min(1).max(LIMITS.displayNameMax),
  image: z.string().max(MCP_IMAGE_MAX_LENGTH).nullable(),
  role: z.enum(["owner", "member"]),
  status: z.enum(["active", "removed", "deleted"]),
  joinedAt: z.number(),
  isSelf: z.boolean(),
});

export type McpMemberView = z.infer<typeof mcpMemberViewSchema>;

const mcpHistoryMoneySchema = z.object({
  minorUnits: z.number().int(),
  currency: z.string().min(1).max(3),
});

const mcpHistoryChangeSchema = z.object({
  field: z.string().min(1).max(100),
  from: z.string().max(2000).optional(),
  to: z.string().max(2000).optional(),
  fromMoney: mcpHistoryMoneySchema.optional(),
  toMoney: mcpHistoryMoneySchema.optional(),
});

export const mcpCircleHistoryEventSchema = z.object({
  id: z.string().min(1).max(128),
  action: z.string().min(1).max(100),
  createdAt: z.number(),
  actor: z
    .object({
      displayName: z.string().min(1).max(LIMITS.displayNameMax),
      image: z.string().max(MCP_IMAGE_MAX_LENGTH).nullable(),
    })
    .nullable(),
  changes: z.array(mcpHistoryChangeSchema).max(20),
});

export type McpCircleHistoryEvent = z.infer<typeof mcpCircleHistoryEventSchema>;

export const mcpPaginationOptsSchema = z.object({
  numItems: z.number().int().min(1).max(100),
  cursor: z.string().max(4096).nullable(),
});

export const mcpCircleRefSchema = z.string().min(1).max(300);

function mcpPaginatedSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    page: z.array(itemSchema).max(100),
    isDone: z.boolean(),
    continueCursor: z.string().max(4096),
  });
}

export const mcpPaginatedMembersSchema = mcpPaginatedSchema(mcpMemberViewSchema);

export const mcpPaginatedCircleHistorySchema = mcpPaginatedSchema(mcpCircleHistoryEventSchema);

export const mcpTransactionRefSchema = z.string().min(1).max(300);

export const mcpMemberAttributionSchema = z.object({
  displayName: z.string().min(1).max(LIMITS.displayNameMax),
  image: z.string().max(MCP_IMAGE_MAX_LENGTH).nullable(),
});

export type McpMemberAttribution = z.infer<typeof mcpMemberAttributionSchema>;

export const mcpCategoryAttributionSchema = z.object({
  ref: z.string().min(1).max(300),
  name: z.string().min(1).max(LIMITS.categoryNameMax),
  color: z.string().min(1).max(64),
});

export type McpCategoryAttribution = z.infer<typeof mcpCategoryAttributionSchema>;

export const mcpTransactionAuditSchema = z.object({
  createdBy: mcpMemberAttributionSchema,
  createdAt: z.number(),
  updatedBy: mcpMemberAttributionSchema,
  updatedAt: z.number(),
});

const mcpTransactionActionsSchema = z.object({
  canEditFields: z.boolean(),
  canArchive: z.boolean(),
});

export const mcpTransactionSummarySchema = z
  .object({
    ref: mcpTransactionRefSchema,
    type: z.enum(["expense", "income"]),
    title: z.string().min(1).max(LIMITS.transactionTitleMax),
    note: z.string().max(LIMITS.transactionNoteMax).optional(),
    amountMinorUnits: z.number().int().min(0),
    currency: z.string().min(1).max(3),
    date: z.string().min(1).max(10),
    month: z.string().min(1).max(7),
    status: z.enum(["active", "archived"]),
    recordedBy: mcpMemberAttributionSchema,
    paidBy: mcpMemberAttributionSchema,
    categories: z.array(mcpCategoryAttributionSchema).max(20),
  })
  .merge(mcpTransactionActionsSchema);

export type McpTransactionSummary = z.infer<typeof mcpTransactionSummarySchema>;

export const mcpTransactionDetailSchema = mcpTransactionSummarySchema.extend({
  audit: mcpTransactionAuditSchema,
});

export type McpTransactionDetail = z.infer<typeof mcpTransactionDetailSchema>;

export const mcpPaginatedTransactionHistorySchema = mcpPaginatedSchema(mcpCircleHistoryEventSchema);

export const mcpSearchTransactionsOffsetResultSchema = z.object({
  pagination: z.literal("offset"),
  transactions: z.array(mcpTransactionSummarySchema).max(100),
  pageNumber: z.number().int().min(1).max(40),
  pageSize: z.number().int().min(1).max(100),
  totalCount: z.number().int().min(0),
  totalCountCapped: z.boolean(),
});

export const mcpSearchTransactionsCursorResultSchema = z.object({
  pagination: z.literal("cursor"),
  page: z.array(mcpTransactionSummarySchema).max(100),
  isDone: z.boolean(),
  continueCursor: z.string().max(4096),
});

export const mcpSearchTransactionsResultSchema = z.discriminatedUnion("pagination", [
  mcpSearchTransactionsOffsetResultSchema,
  mcpSearchTransactionsCursorResultSchema,
]);

export type McpSearchTransactionsResult = z.infer<typeof mcpSearchTransactionsResultSchema>;

export const mcpMonthTotalsSchema = z.object({
  incomeMinor: z.number().int(),
  expenseMinor: z.number().int(),
  netMinor: z.number().int(),
});

export type McpMonthTotals = z.infer<typeof mcpMonthTotalsSchema>;

export const mcpPaginatedTransactionSummariesSchema = mcpPaginatedSchema(
  mcpTransactionSummarySchema,
);

export const mcpMonthlyLedgerSchema = z.object({
  month: z.string().min(1).max(7),
  totals: mcpMonthTotalsSchema,
  currency: z.string().min(1).max(3),
  transactions: mcpPaginatedTransactionSummariesSchema,
});

export type McpMonthlyLedger = z.infer<typeof mcpMonthlyLedgerSchema>;

/** Dashboard recent feed cap — mirrors `dashboard.RECENT_TRANSACTIONS_LIMIT`. */
const mcpDashboardRecentMax = 5;

export const mcpDashboardSchema = z.object({
  month: z.string().min(1).max(7),
  totals: mcpMonthTotalsSchema,
  recent: z.array(mcpTransactionSummarySchema).max(mcpDashboardRecentMax),
  currency: z.string().min(1).max(3),
});

export type McpDashboard = z.infer<typeof mcpDashboardSchema>;

export const mcpComparisonRangeMonthsSchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(6),
  z.literal(12),
]);

export const mcpMonthlyComparisonPointSchema = mcpMonthTotalsSchema.extend({
  month: z.string().min(1).max(7),
});

export const mcpMonthlyComparisonSchema = z.object({
  series: z.array(mcpMonthlyComparisonPointSchema).max(12),
  currency: z.string().min(1).max(3),
});

export type McpMonthlyComparison = z.infer<typeof mcpMonthlyComparisonSchema>;

export const mcpCategoryAnalyticsRowSchema = z.object({
  ref: z.string().min(1).max(300),
  name: z.string().min(1).max(LIMITS.categoryNameMax),
  color: z.string().min(1).max(64),
  status: z.enum(["active", "archived"]),
  taggedTotalMinor: z.number().int().min(0),
  txnCount: z.number().int().min(0),
});

export type McpCategoryAnalyticsRow = z.infer<typeof mcpCategoryAnalyticsRowSchema>;

export const mcpCategoryAnalyticsSchema = z.object({
  month: z.string().min(1).max(7),
  type: z.enum(["expense", "income"]),
  /** Multi-Category Transactions contribute their full amount to each Category row. */
  nonAdditive: z.literal(true),
  currency: z.string().min(1).max(3),
  /** Fingerprint of the full ranked row set; continuation cursors are valid only while this matches. */
  rankingRevision: z.string().min(1).max(64),
  page: z.array(mcpCategoryAnalyticsRowSchema).max(100),
  isDone: z.boolean(),
  continueCursor: z.string().max(4096),
});

export type McpCategoryAnalytics = z.infer<typeof mcpCategoryAnalyticsSchema>;

export const mcpCategoryRefSchema = z.string().min(1).max(300);

const mcpCategoryCreatorSchema = z.object({
  displayName: z.string().min(1).max(LIMITS.displayNameMax),
  image: z.string().max(MCP_IMAGE_MAX_LENGTH).nullable(),
});

const mcpCategoryActionsSchema = z.object({
  canEditFields: z.boolean(),
  canArchive: z.boolean(),
});

export const mcpCategorySummarySchema = z.object({
  ref: mcpCategoryRefSchema,
  name: z.string().min(1).max(LIMITS.categoryNameMax),
  type: z.enum(["expense", "income"]),
  color: z.string().min(1).max(64),
  status: z.enum(["active", "archived"]),
  creator: mcpCategoryCreatorSchema,
});

export type McpCategorySummary = z.infer<typeof mcpCategorySummarySchema>;

export const mcpCategoryDetailSchema = mcpCategorySummarySchema.merge(mcpCategoryActionsSchema);

export type McpCategoryDetail = z.infer<typeof mcpCategoryDetailSchema>;

export const mcpPaginatedCategoriesSchema = mcpPaginatedSchema(mcpCategorySummarySchema);

const mcpCategoryFilterTypeSchema = z.enum(["all", "expense", "income"]);
const mcpCategoryLifecycleFilterSchema = z.enum(["active", "archived", "all"]);

export const mcpListCategoriesFiltersSchema = z.object({
  type: mcpCategoryFilterTypeSchema.optional(),
  status: mcpCategoryLifecycleFilterSchema.optional(),
  query: z.string().max(LIMITS.categoryNameMax).optional(),
});

export const mcpListCategoryTransactionsResultSchema = z.object({
  transactions: z.array(mcpTransactionSummarySchema).max(5),
});

export type McpListCategoryTransactionsResult = z.infer<
  typeof mcpListCategoryTransactionsResultSchema
>;

export const mcpPaginatedCategoryHistorySchema = mcpPaginatedSchema(mcpCircleHistoryEventSchema);

const mcpTransactionFilterTypeSchema = z.enum(["all", "expense", "income"]);
const mcpTransactionLifecycleFilterSchema = z.enum(["active", "archived", "all"]);

export const mcpSearchTransactionsFiltersSchema = z
  .object({
    query: z.string().max(LIMITS.transactionSearchQueryMax).optional(),
    type: mcpTransactionFilterTypeSchema.optional(),
    status: mcpTransactionLifecycleFilterSchema.optional(),
    categoryRefs: z.array(z.string().min(1).max(300)).max(20).optional(),
    recordedByMemberIds: z.array(z.string().min(1).max(128)).max(20).optional(),
    paidByMemberIds: z.array(z.string().min(1).max(128)).max(20).optional(),
    dateFrom: z.string().max(10).optional(),
    dateTo: z.string().max(10).optional(),
    amountMin: z.number().int().min(0).optional(),
    amountMax: z.number().int().min(0).optional(),
    month: z.string().max(7).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.month !== undefined && (value.dateFrom !== undefined || value.dateTo !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Provide either month or dateFrom/dateTo, not both",
      });
    }
  });

const mcpSearchTransactionsCoreSchema = z.object({
  circleRef: mcpCircleRefSchema,
  filters: mcpSearchTransactionsFiltersSchema.optional(),
  page: z.number().int().min(1).max(40).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  paginationOpts: mcpPaginationOptsSchema.optional(),
});

function refineMcpSearchTransactionsPagination(
  value: z.infer<typeof mcpSearchTransactionsCoreSchema>,
  ctx: z.RefinementCtx,
) {
  if (
    value.paginationOpts !== undefined &&
    (value.page !== undefined || value.pageSize !== undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "search_transactions accepts either paginationOpts or page/pageSize, not both",
    });
  }
}

export const mcpSearchTransactionsInputSchema = mcpSearchTransactionsCoreSchema.superRefine(
  refineMcpSearchTransactionsPagination,
);

const mcpSearchTransactionsOperationSchema = mcpSearchTransactionsCoreSchema
  .extend({
    kind: z.literal("search_transactions"),
  })
  .superRefine(refineMcpSearchTransactionsPagination);

export const mcpReadOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("get_current_user") }),
  z.object({ kind: z.literal("list_authorized_circles") }),
  z.object({ kind: z.literal("get_circle"), circleRef: mcpCircleRefSchema }),
  z.object({
    kind: z.literal("list_members"),
    circleRef: mcpCircleRefSchema,
    includeHistorical: z.boolean().optional(),
    paginationOpts: mcpPaginationOptsSchema.optional(),
  }),
  z.object({
    kind: z.literal("list_circle_history"),
    circleRef: mcpCircleRefSchema,
    paginationOpts: mcpPaginationOptsSchema.optional(),
  }),
  mcpSearchTransactionsOperationSchema,
  z.object({
    kind: z.literal("get_transaction"),
    circleRef: mcpCircleRefSchema,
    transactionRef: mcpTransactionRefSchema,
  }),
  z.object({
    kind: z.literal("list_transaction_history"),
    circleRef: mcpCircleRefSchema,
    transactionRef: mcpTransactionRefSchema,
    paginationOpts: mcpPaginationOptsSchema.optional(),
  }),
  z.object({
    kind: z.literal("get_monthly_ledger"),
    circleRef: mcpCircleRefSchema,
    month: z.string().max(7),
    paginationOpts: mcpPaginationOptsSchema.optional(),
  }),
  z.object({
    kind: z.literal("get_dashboard"),
    circleRef: mcpCircleRefSchema,
    month: z.string().max(7),
  }),
  z.object({
    kind: z.literal("get_monthly_comparison"),
    circleRef: mcpCircleRefSchema,
    endMonth: z.string().max(7),
    rangeMonths: mcpComparisonRangeMonthsSchema,
  }),
  z.object({
    kind: z.literal("get_category_analytics"),
    circleRef: mcpCircleRefSchema,
    month: z.string().max(7),
    type: z.enum(["expense", "income"]),
    paginationOpts: mcpPaginationOptsSchema.optional(),
  }),
  z.object({
    kind: z.literal("list_categories"),
    circleRef: mcpCircleRefSchema,
    filters: mcpListCategoriesFiltersSchema.optional(),
    paginationOpts: mcpPaginationOptsSchema.optional(),
  }),
  z.object({
    kind: z.literal("get_category"),
    circleRef: mcpCircleRefSchema,
    categoryRef: mcpCategoryRefSchema,
  }),
  z.object({
    kind: z.literal("list_category_transactions"),
    circleRef: mcpCircleRefSchema,
    categoryRef: mcpCategoryRefSchema,
  }),
  z.object({
    kind: z.literal("list_category_history"),
    circleRef: mcpCircleRefSchema,
    categoryRef: mcpCategoryRefSchema,
    paginationOpts: mcpPaginationOptsSchema.optional(),
  }),
]);

export type McpReadOperation = z.infer<typeof mcpReadOperationSchema>;

export const mcpReadOperationBodySchema = z.object({
  grantId: z.string().min(1).max(128),
  effectiveScopes: z.array(z.string().max(64)).max(MCP_SCOPES.length),
  operation: mcpReadOperationSchema,
});

export type McpReadOperationBody = z.infer<typeof mcpReadOperationBodySchema>;

const mcpCreateTransactionCoreSchema = z.object({
  circleRef: mcpCircleRefSchema,
  type: z.enum(["expense", "income"]),
  title: transactionFieldSchemas.title,
  note: transactionFieldSchemas.note.optional(),
  amountMinorUnits: z
    .number()
    .int()
    .refine(isValidMinorUnits, { message: "Amount must be a positive value within range" }),
  date: transactionFieldSchemas.date,
  categoryRefs: z.array(mcpCategoryRefSchema).min(1).max(LIMITS.maxCategoriesPerTransaction),
  paidByMemberId: z.string().min(1).max(128).optional(),
  expectedCurrency: z.string().min(1).max(3),
});

function refineUniqueCategoryRefs(
  value: z.infer<typeof mcpCreateTransactionCoreSchema>,
  ctx: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const ref of value.categoryRefs) {
    if (seen.has(ref)) {
      ctx.addIssue({
        code: "custom",
        message: "Category references must be unique",
        path: ["categoryRefs"],
      });
      return;
    }
    seen.add(ref);
  }
}

export const mcpCreateTransactionInputSchema =
  mcpCreateTransactionCoreSchema.superRefine(refineUniqueCategoryRefs);

export type McpCreateTransactionInput = z.infer<typeof mcpCreateTransactionInputSchema>;

export const mcpCreateTransactionResultSchema = z.object({
  ref: mcpTransactionRefSchema,
  transaction: mcpTransactionDetailSchema,
});

export type McpCreateTransactionResult = z.infer<typeof mcpCreateTransactionResultSchema>;

const mcpCreateTransactionOperationSchema = mcpCreateTransactionCoreSchema
  .extend({
    kind: z.literal("create_transaction"),
  })
  .superRefine(refineUniqueCategoryRefs);

export const mcpWriteOperationSchema = z.discriminatedUnion("kind", [
  mcpCreateTransactionOperationSchema,
]);

export type McpWriteOperation = z.infer<typeof mcpWriteOperationSchema>;

export const mcpOperationBodySchema = z.object({
  grantId: z.string().min(1).max(128),
  effectiveScopes: z.array(z.string().max(64)).max(MCP_SCOPES.length),
  operation: z.discriminatedUnion("kind", [
    ...mcpReadOperationSchema.options,
    ...mcpWriteOperationSchema.options,
  ]),
});

export type McpOperationBody = z.infer<typeof mcpOperationBodySchema>;

export const mcpWriteOperationBodySchema = z.object({
  grantId: z.string().min(1).max(128),
  effectiveScopes: z.array(z.string().max(64)).max(MCP_SCOPES.length),
  operation: mcpWriteOperationSchema,
});

export type McpWriteOperationBody = z.infer<typeof mcpWriteOperationBodySchema>;
