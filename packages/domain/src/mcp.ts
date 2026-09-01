import { z } from "zod";

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
  image: z.string().nullable(),
  createdAt: z.number(),
});

export type McpCurrentUserView = z.infer<typeof mcpCurrentUserViewSchema>;

export const mcpCircleViewSchema = z.object({
  id: z.string(),
  ref: z.string(),
  name: z.string(),
  kind: z.enum(["personal", "regular"]),
  currency: z.string(),
  color: z.string(),
  mark: z.string(),
  status: z.enum(["active", "archived"]),
  setupComplete: z.boolean(),
  currencyLocked: z.boolean(),
  isOwner: z.boolean(),
});

export type McpCircleView = z.infer<typeof mcpCircleViewSchema>;

export const mcpMemberViewSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  image: z.string().nullable(),
  role: z.enum(["owner", "member"]),
  status: z.enum(["active", "removed", "deleted"]),
  joinedAt: z.number(),
  isSelf: z.boolean(),
});

export type McpMemberView = z.infer<typeof mcpMemberViewSchema>;

const mcpHistoryMoneySchema = z.object({
  minorUnits: z.number().int(),
  currency: z.string(),
});

const mcpHistoryChangeSchema = z.object({
  field: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  fromMoney: mcpHistoryMoneySchema.optional(),
  toMoney: mcpHistoryMoneySchema.optional(),
});

export const mcpCircleHistoryEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  createdAt: z.number(),
  actor: z
    .object({
      displayName: z.string(),
      image: z.string().nullable(),
    })
    .nullable(),
  changes: z.array(mcpHistoryChangeSchema),
});

export type McpCircleHistoryEvent = z.infer<typeof mcpCircleHistoryEventSchema>;

export const mcpPaginationOptsSchema = z.object({
  numItems: z.number().int().min(1).max(100),
  cursor: z.string().nullable(),
});

const mcpCircleRefSchema = z.string().min(1).max(300);

export const mcpPaginatedMembersSchema = z.object({
  page: z.array(mcpMemberViewSchema),
  isDone: z.boolean(),
  continueCursor: z.string(),
});

export const mcpPaginatedCircleHistorySchema = z.object({
  page: z.array(mcpCircleHistoryEventSchema),
  isDone: z.boolean(),
  continueCursor: z.string(),
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
]);

export type McpReadOperation = z.infer<typeof mcpReadOperationSchema>;

export const mcpOperationBodySchema = z.object({
  grantId: z.string(),
  effectiveScopes: z.array(z.string()),
  operation: mcpReadOperationSchema,
});

export type McpOperationBody = z.infer<typeof mcpOperationBodySchema>;
