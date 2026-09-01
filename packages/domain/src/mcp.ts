import { z } from "zod";
import { LIMITS } from "./validation.js";

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

const mcpTransactionFilterTypeSchema = z.enum(["all", "expense", "income"]);
const mcpTransactionLifecycleFilterSchema = z.enum(["active", "archived", "all"]);

export const mcpSearchTransactionsFiltersSchema = z.object({
  query: z.string().max(LIMITS.transactionTitleMax).optional(),
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
});

const mcpSearchTransactionsOperationSchema = z
  .object({
    kind: z.literal("search_transactions"),
    circleRef: mcpCircleRefSchema,
    filters: mcpSearchTransactionsFiltersSchema.optional(),
    page: z.number().int().min(1).max(40).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    paginationOpts: mcpPaginationOptsSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.paginationOpts !== undefined &&
      (value.page !== undefined || value.pageSize !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "search_transactions accepts either paginationOpts or page/pageSize, not both",
      });
    }
  });

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
]);

export type McpReadOperation = z.infer<typeof mcpReadOperationSchema>;

export const mcpOperationBodySchema = z.object({
  grantId: z.string().min(1).max(128),
  effectiveScopes: z.array(z.string().max(64)).max(MCP_SCOPES.length),
  operation: mcpReadOperationSchema,
});

export type McpOperationBody = z.infer<typeof mcpOperationBodySchema>;
