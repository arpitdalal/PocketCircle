import {
  bearerAuthChallengeResponse,
  McpServer,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";
import {
  type McpReadOperation,
  type McpWriteOperation,
  mcpArchiveTransactionInputSchema,
  mcpArchiveTransactionResultSchema,
  mcpCategoryAnalyticsSchema,
  mcpCategoryDetailSchema,
  mcpCategoryRefSchema,
  mcpCircleRefSchema,
  mcpCircleViewSchema,
  mcpComparisonRangeMonthsSchema,
  mcpCreateCategoryInputSchema,
  mcpCreateCategoryResultSchema,
  mcpCreateTransactionInputSchema,
  mcpCreateTransactionResultSchema,
  mcpCurrentUserViewSchema,
  mcpDashboardSchema,
  mcpListCategoriesFiltersSchema,
  mcpListCategoryTransactionsResultSchema,
  mcpMonthlyComparisonSchema,
  mcpMonthlyLedgerSchema,
  mcpPaginatedCategoriesSchema,
  mcpPaginatedCategoryHistorySchema,
  mcpPaginatedCircleHistorySchema,
  mcpPaginatedMembersSchema,
  mcpPaginatedTransactionHistorySchema,
  mcpPaginationOptsSchema,
  mcpRestoreTransactionInputSchema,
  mcpRestoreTransactionResultSchema,
  mcpSearchTransactionsInputSchema,
  mcpSearchTransactionsResultSchema,
  mcpTransactionDetailSchema,
  mcpTransactionRefSchema,
  mcpUpdateCategoryInputSchema,
  mcpUpdateCategoryResultSchema,
  mcpUpdateTransactionInputSchema,
  mcpUpdateTransactionResultSchema,
} from "@pocketcircle/domain";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { executeMcpOperation } from "./convex-bridge.js";
import type { Env } from "./env.js";
import { pocketCircleOAuthApi } from "./oauth-options.js";
import { assertMcpWriteWithinRateLimit } from "./write-rate-limit.js";

function hostnameOf(urlString: string | undefined) {
  if (!urlString) {
    return null;
  }
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

const grantPropsSchema = z.object({ mcpGrantId: z.string().min(1) });

async function resolveAuthorizedCaller(env: Env, req?: Request) {
  const authHeader = req?.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) {
    return { ok: false as const, error: "missing_bearer_token" };
  }

  const oauthProvider = env.OAUTH_PROVIDER ?? pocketCircleOAuthApi(env);
  const summary = await oauthProvider.unwrapToken(token);
  if (!summary) {
    return { ok: false as const, error: "invalid_token" };
  }
  const parsedProps = grantPropsSchema.safeParse(summary.grant.props);
  if (!parsedProps.success) {
    return { ok: false as const, error: "missing_grant_props" };
  }
  return {
    ok: true as const,
    value: {
      grantId: parsedProps.data.mcpGrantId,
      effectiveScopes: summary.scope,
    },
  };
}

const listCirclesOutputSchema = z.object({
  circles: z.array(mcpCircleViewSchema),
});

const circleRefInputSchema = z.object({ circleRef: mcpCircleRefSchema });
const listMembersInputSchema = circleRefInputSchema.extend({
  includeHistorical: z.boolean().optional(),
  paginationOpts: mcpPaginationOptsSchema.optional(),
});
const listCircleHistoryInputSchema = circleRefInputSchema.extend({
  paginationOpts: mcpPaginationOptsSchema.optional(),
});
const transactionRefInputSchema = circleRefInputSchema.extend({
  transactionRef: mcpTransactionRefSchema,
});
const listTransactionHistoryInputSchema = transactionRefInputSchema.extend({
  paginationOpts: mcpPaginationOptsSchema.optional(),
});
const monthlyLedgerInputSchema = circleRefInputSchema.extend({
  month: z.string().max(7),
  paginationOpts: mcpPaginationOptsSchema.optional(),
});
const dashboardInputSchema = circleRefInputSchema.extend({
  month: z.string().max(7),
});
const monthlyComparisonInputSchema = circleRefInputSchema.extend({
  endMonth: z.string().max(7),
  rangeMonths: mcpComparisonRangeMonthsSchema,
});
const categoryAnalyticsInputSchema = circleRefInputSchema.extend({
  month: z.string().max(7),
  type: z.enum(["expense", "income"]),
  paginationOpts: mcpPaginationOptsSchema.optional(),
});
const listCategoriesInputSchema = circleRefInputSchema.extend({
  filters: mcpListCategoriesFiltersSchema.optional(),
  paginationOpts: mcpPaginationOptsSchema.optional(),
});
const categoryRefInputSchema = circleRefInputSchema.extend({
  categoryRef: mcpCategoryRefSchema,
});
const listCategoryHistoryInputSchema = categoryRefInputSchema.extend({
  paginationOpts: mcpPaginationOptsSchema.optional(),
});

async function handleToolExecution<T>(
  env: Env,
  request: Request | undefined,
  ctxReq: Request | undefined,
  operation: McpReadOperation | McpWriteOperation,
  schema: z.ZodType<T>,
) {
  const caller = await resolveAuthorizedCaller(env, ctxReq ?? request);
  if (!caller.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Authorization failed: ${caller.error}` }],
    };
  }
  const result = await executeMcpOperation(
    env,
    {
      grantId: caller.value.grantId,
      effectiveScopes: caller.value.effectiveScopes,
      operation,
    },
    schema,
  );
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `PocketCircle error: ${result.error}` }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
    structuredContent: result.value,
  };
}

export function buildMcpServer(env: Env, request?: Request) {
  const server = new McpServer({ name: "PocketCircle MCP", version: "0.1.0" });

  server.registerTool(
    "get_current_user",
    {
      title: "Get Current User",
      description: "Get the authenticated PocketCircle user's identity",
      inputSchema: z.object({}),
      outputSchema: mcpCurrentUserViewSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (_args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        { kind: "get_current_user" },
        mcpCurrentUserViewSchema,
      ),
  );

  server.registerTool(
    "list_authorized_circles",
    {
      title: "List Authorized Circles",
      description: "List PocketCircle circles authorized by the user for this connection",
      inputSchema: z.object({}),
      outputSchema: listCirclesOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (_args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        { kind: "list_authorized_circles" },
        listCirclesOutputSchema,
      ),
  );

  server.registerTool(
    "get_circle",
    {
      title: "Get Circle",
      description:
        "Get safe identity, currency, lifecycle, setup, and permissions for an authorized Circle",
      inputSchema: circleRefInputSchema,
      outputSchema: mcpCircleViewSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        { kind: "get_circle", circleRef: args.circleRef },
        mcpCircleViewSchema,
      ),
  );

  server.registerTool(
    "list_members",
    {
      title: "List Circle Members",
      description: "List display identities, roles, and lifecycle status for an authorized Circle",
      inputSchema: listMembersInputSchema,
      outputSchema: mcpPaginatedMembersSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "list_members",
          circleRef: args.circleRef,
          ...(args.includeHistorical === undefined
            ? {}
            : { includeHistorical: args.includeHistorical }),
          ...(args.paginationOpts === undefined ? {} : { paginationOpts: args.paginationOpts }),
        },
        mcpPaginatedMembersSchema,
      ),
  );

  server.registerTool(
    "list_circle_history",
    {
      title: "List Circle History",
      description:
        "List paginated Circle, membership, ownership, lifecycle, invitation, and settings history",
      inputSchema: listCircleHistoryInputSchema,
      outputSchema: mcpPaginatedCircleHistorySchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "list_circle_history",
          circleRef: args.circleRef,
          ...(args.paginationOpts === undefined ? {} : { paginationOpts: args.paginationOpts }),
        },
        mcpPaginatedCircleHistorySchema,
      ),
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search Transactions",
      description:
        "Search and page Transactions in an authorized Circle using the same filters as Transaction Search and Monthly Ledger",
      inputSchema: mcpSearchTransactionsInputSchema,
      outputSchema: mcpSearchTransactionsResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "search_transactions",
          circleRef: args.circleRef,
          ...(args.filters === undefined ? {} : { filters: args.filters }),
          ...(args.page === undefined ? {} : { page: args.page }),
          ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
          ...(args.paginationOpts === undefined ? {} : { paginationOpts: args.paginationOpts }),
        },
        mcpSearchTransactionsResultSchema,
      ),
  );

  server.registerTool(
    "get_transaction",
    {
      title: "Get Transaction",
      description:
        "Get one Transaction with Amount, Currency, Categories, attribution, Audit Metadata, and permitted actions",
      inputSchema: transactionRefInputSchema,
      outputSchema: mcpTransactionDetailSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "get_transaction",
          circleRef: args.circleRef,
          transactionRef: args.transactionRef,
        },
        mcpTransactionDetailSchema,
      ),
  );

  server.registerTool(
    "list_transaction_history",
    {
      title: "List Transaction History",
      description:
        "List paginated immutable Transaction history with actor, changed fields, and display values",
      inputSchema: listTransactionHistoryInputSchema,
      outputSchema: mcpPaginatedTransactionHistorySchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "list_transaction_history",
          circleRef: args.circleRef,
          transactionRef: args.transactionRef,
          ...(args.paginationOpts === undefined ? {} : { paginationOpts: args.paginationOpts }),
        },
        mcpPaginatedTransactionHistorySchema,
      ),
  );

  server.registerTool(
    "get_monthly_ledger",
    {
      title: "Get Monthly Ledger",
      description:
        "Get one authorized Circle-month's active Income, Expense, and Net totals in minor units plus deterministically date-ordered active Transactions. Archived Transactions are excluded from totals and the list.",
      inputSchema: monthlyLedgerInputSchema,
      outputSchema: mcpMonthlyLedgerSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "get_monthly_ledger",
          circleRef: args.circleRef,
          month: args.month,
          ...(args.paginationOpts === undefined ? {} : { paginationOpts: args.paginationOpts }),
        },
        mcpMonthlyLedgerSchema,
      ),
  );

  server.registerTool(
    "get_dashboard",
    {
      title: "Get Dashboard",
      description:
        "Get the selected month's active Income, Expense, and Net totals plus a bounded recent-activity feed for an authorized Circle. month must be the caller's local YYYY-MM. Archived Transactions are excluded.",
      inputSchema: dashboardInputSchema,
      outputSchema: mcpDashboardSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "get_dashboard",
          circleRef: args.circleRef,
          month: args.month,
        },
        mcpDashboardSchema,
      ),
  );

  server.registerTool(
    "get_monthly_comparison",
    {
      title: "Get Monthly Comparison",
      description:
        "Compare active Income, Expense, and Net in minor units across the supported 1, 3, 6, or 12 month Comparison Ranges ending at endMonth. endMonth must be the caller's local YYYY-MM. Archived Transactions are excluded.",
      inputSchema: monthlyComparisonInputSchema,
      outputSchema: mcpMonthlyComparisonSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "get_monthly_comparison",
          circleRef: args.circleRef,
          endMonth: args.endMonth,
          rangeMonths: args.rangeMonths,
        },
        mcpMonthlyComparisonSchema,
      ),
  );

  server.registerTool(
    "get_category_analytics",
    {
      title: "Get Category Analytics",
      description:
        "Get ranked, non-additive active tagged spend or income by Category for one bounded month in an authorized Circle. type selects expense or income Categories; month must be the caller's local YYYY-MM. Multi-Category Transactions contribute their full amount to each Category row, so row totals must not be summed. Archived Transactions are excluded. Results paginate via paginationOpts (default first 50 rows) using a rankingRevision-tied cursor; restart from page 1 when stale_pagination is returned.",
      inputSchema: categoryAnalyticsInputSchema,
      outputSchema: mcpCategoryAnalyticsSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "get_category_analytics",
          circleRef: args.circleRef,
          month: args.month,
          type: args.type,
          ...(args.paginationOpts === undefined ? {} : { paginationOpts: args.paginationOpts }),
        },
        mcpCategoryAnalyticsSchema,
      ),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List Categories",
      description:
        "List Categories in an authorized Circle with optional Transaction type, lifecycle scope (active, archived, or all), and case-insensitive name filtering. Defaults to active Categories. Archived Categories remain readable for history but are not valid new Transaction selections. Results paginate via paginationOpts (default first 50 rows).",
      inputSchema: listCategoriesInputSchema,
      outputSchema: mcpPaginatedCategoriesSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "list_categories",
          circleRef: args.circleRef,
          ...(args.filters === undefined ? {} : { filters: args.filters }),
          ...(args.paginationOpts === undefined ? {} : { paginationOpts: args.paginationOpts }),
        },
        mcpPaginatedCategoriesSchema,
      ),
  );

  server.registerTool(
    "get_category",
    {
      title: "Get Category",
      description:
        "Get one Category's name, Transaction type, color, lifecycle status, creator attribution, and permitted actions. Archived Categories remain readable because they stay attached to historical Transactions.",
      inputSchema: categoryRefInputSchema,
      outputSchema: mcpCategoryDetailSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "get_category",
          circleRef: args.circleRef,
          categoryRef: args.categoryRef,
        },
        mcpCategoryDetailSchema,
      ),
  );

  server.registerTool(
    "list_category_transactions",
    {
      title: "List Category Transactions",
      description:
        "List up to five recent Transactions linked to a Category, ordered by Transaction Date then creation time. Includes active and archived Transactions. Archived Categories remain readable.",
      inputSchema: categoryRefInputSchema,
      outputSchema: mcpListCategoryTransactionsResultSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "list_category_transactions",
          circleRef: args.circleRef,
          categoryRef: args.categoryRef,
        },
        mcpListCategoryTransactionsResultSchema,
      ),
  );

  server.registerTool(
    "list_category_history",
    {
      title: "List Category History",
      description:
        "List paginated immutable Category history with actor, changed fields, and display values. Archived Categories remain readable.",
      inputSchema: listCategoryHistoryInputSchema,
      outputSchema: mcpPaginatedCategoryHistorySchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "list_category_history",
          circleRef: args.circleRef,
          categoryRef: args.categoryRef,
          ...(args.paginationOpts === undefined ? {} : { paginationOpts: args.paginationOpts }),
        },
        mcpPaginatedCategoryHistorySchema,
      ),
  );

  server.registerTool(
    "create_category",
    {
      title: "Create Category",
      description:
        "Create an Expense or Income Category in an authorized, setup-complete Circle. The authenticated Member becomes the creator. Names are case-insensitively unique per Circle and Transaction type, including names held by Archived Categories. Repeating the same call may create another Category when the name differs.",
      inputSchema: mcpCreateCategoryInputSchema,
      outputSchema: mcpCreateCategoryResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "create_category",
          circleRef: args.circleRef,
          name: args.name,
          type: args.type,
          color: args.color,
        },
        mcpCreateCategoryResultSchema,
      ),
  );

  server.registerTool(
    "update_category",
    {
      title: "Update Category",
      description:
        "Update an active Category's name and/or color in an authorized, setup-complete Circle. Only the Category creator may edit fields; the Circle Owner may not rename or recolor another Member's Category. A true no-op returns the current Category without a spurious history event. Archived Categories cannot be updated.",
      inputSchema: mcpUpdateCategoryInputSchema,
      outputSchema: mcpUpdateCategoryResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "update_category",
          circleRef: args.circleRef,
          categoryRef: args.categoryRef,
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.color === undefined ? {} : { color: args.color }),
        },
        mcpUpdateCategoryResultSchema,
      ),
  );

  server.registerTool(
    "create_transaction",
    {
      title: "Create Transaction",
      description:
        "Create an Expense or Income in an authorized, setup-complete Circle. Recorded By is always the authenticated Member. Paid By defaults to Recorded By. Category references must be active, unique, in the same Circle, and match the Transaction type. Expected Currency must match the Circle Currency. Repeating the same call may create another Transaction.",
      inputSchema: mcpCreateTransactionInputSchema,
      outputSchema: mcpCreateTransactionResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "create_transaction",
          circleRef: args.circleRef,
          type: args.type,
          title: args.title,
          ...(args.note === undefined ? {} : { note: args.note }),
          amountMinorUnits: args.amountMinorUnits,
          date: args.date,
          categoryRefs: args.categoryRefs,
          ...(args.paidByMemberId === undefined ? {} : { paidByMemberId: args.paidByMemberId }),
          expectedCurrency: args.expectedCurrency,
        },
        mcpCreateTransactionResultSchema,
      ),
  );

  server.registerTool(
    "update_transaction",
    {
      title: "Update Transaction",
      description:
        "Update an active Transaction in an authorized, setup-complete Circle. Only the Recorded By Member may edit fields. Optional updates cover title, note, amount, date, categories, Paid By, and type. Type changes require a complete valid category set for the new type. Expected Currency is required when changing amount. A true no-op returns the current Transaction without a spurious history event.",
      inputSchema: mcpUpdateTransactionInputSchema,
      outputSchema: mcpUpdateTransactionResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "update_transaction",
          circleRef: args.circleRef,
          transactionRef: args.transactionRef,
          ...(args.type === undefined ? {} : { type: args.type }),
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.note === undefined ? {} : { note: args.note }),
          ...(args.amountMinorUnits === undefined
            ? {}
            : { amountMinorUnits: args.amountMinorUnits }),
          ...(args.date === undefined ? {} : { date: args.date }),
          ...(args.categoryRefs === undefined ? {} : { categoryRefs: args.categoryRefs }),
          ...(args.paidByMemberId === undefined ? {} : { paidByMemberId: args.paidByMemberId }),
          ...(args.expectedCurrency === undefined
            ? {}
            : { expectedCurrency: args.expectedCurrency }),
        },
        mcpUpdateTransactionResultSchema,
      ),
  );

  server.registerTool(
    "archive_transaction",
    {
      title: "Archive Transaction",
      description:
        "Archive an active Transaction in an authorized, setup-complete Circle. Requires Recorded By Member or Circle Owner permission. Archiving freezes the Transaction and removes it from Dashboard and report totals without deleting it. Confirm the exact transactionRef before calling. Repeating archive on an already-archived Transaction returns an error.",
      inputSchema: mcpArchiveTransactionInputSchema,
      outputSchema: mcpArchiveTransactionResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "archive_transaction",
          circleRef: args.circleRef,
          transactionRef: args.transactionRef,
        },
        mcpArchiveTransactionResultSchema,
      ),
  );

  server.registerTool(
    "restore_transaction",
    {
      title: "Restore Transaction",
      description:
        "Restore an archived Transaction in an authorized, setup-complete Circle. Requires Recorded By Member or Circle Owner permission. Restoring returns the Transaction to active reporting and field editing for the Recorded By Member. Repeating restore on an already-active Transaction returns an error.",
      inputSchema: mcpRestoreTransactionInputSchema,
      outputSchema: mcpRestoreTransactionResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, ctx) =>
      handleToolExecution(
        env,
        request,
        ctx.http?.req,
        {
          kind: "restore_transaction",
          circleRef: args.circleRef,
          transactionRef: args.transactionRef,
        },
        mcpRestoreTransactionResultSchema,
      ),
  );

  return server;
}

const WRITE_TOOL_NAMES = new Set([
  "create_category",
  "update_category",
  "create_transaction",
  "update_transaction",
  "archive_transaction",
  "restore_transaction",
]);

const READ_TOOL_NAMES = new Set([
  "get_current_user",
  "list_authorized_circles",
  "get_circle",
  "list_members",
  "list_circle_history",
  "search_transactions",
  "get_transaction",
  "list_transaction_history",
  "get_monthly_ledger",
  "get_dashboard",
  "get_monthly_comparison",
  "get_category_analytics",
  "list_categories",
  "get_category",
  "list_category_transactions",
  "list_category_history",
]);

const rpcCallSchema = z.object({
  method: z.string(),
  params: z
    .object({
      name: z.string().optional(),
    })
    .optional(),
});

async function detectWriteToolCall(request: Request) {
  if (request.method.toUpperCase() !== "POST") {
    return false;
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return false;
  }
  try {
    const json: unknown = await request.clone().json();
    const parsed = rpcCallSchema.safeParse(json);
    if (!parsed.success) {
      return false;
    }
    const bodyMethod = parsed.data.method;
    const bodyName = parsed.data.params?.name;

    const mcpMethod = request.headers.get("mcp-method");
    const mcpName = request.headers.get("mcp-name");

    if (mcpMethod && mcpMethod !== bodyMethod) {
      return false;
    }
    if (mcpName && mcpName !== bodyName) {
      return false;
    }

    return (
      bodyMethod === "tools/call" && typeof bodyName === "string" && WRITE_TOOL_NAMES.has(bodyName)
    );
  } catch {
    return false;
  }
}

async function detectReadToolCall(request: Request) {
  if (request.method.toUpperCase() !== "POST") {
    return false;
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return false;
  }
  try {
    const json: unknown = await request.clone().json();
    const parsed = rpcCallSchema.safeParse(json);
    if (!parsed.success) {
      return false;
    }
    const bodyMethod = parsed.data.method;
    const bodyName = parsed.data.params?.name;

    const mcpMethod = request.headers.get("mcp-method");
    const mcpName = request.headers.get("mcp-name");

    // If mirrored headers are present, ensure they don't mismatch the body.
    // Let SDK handler return 400 HeaderMismatch on invalid combinations.
    if (mcpMethod && mcpMethod !== bodyMethod) {
      return false;
    }
    if (mcpName && mcpName !== bodyName) {
      return false;
    }

    return (
      bodyMethod === "tools/call" && typeof bodyName === "string" && READ_TOOL_NAMES.has(bodyName)
    );
  } catch {
    return false;
  }
}

export function createMcpApiHandler(env: Env) {
  const allowedHostnames = new Set(["mcp.pocketcircle.app", "localhost", "127.0.0.1"]);
  const issuerHost = hostnameOf(env.MCP_ISSUER);
  if (issuerHost) {
    allowedHostnames.add(issuerHost);
  }
  const resourceHost = hostnameOf(env.MCP_RESOURCE_URI);
  if (resourceHost) {
    allowedHostnames.add(resourceHost);
  }

  const allowedOriginHostnames = new Set(allowedHostnames);
  allowedOriginHostnames.add("pocketcircle.app");
  const appOriginHost = hostnameOf(env.APP_ORIGIN);
  if (appOriginHost) {
    allowedOriginHostnames.add(appOriginHost);
  }

  const mcpHandler = createMcpHandler((mcpContext) => buildMcpServer(env, mcpContext.requestInfo), {
    legacy: "reject",
    allowedHostnames: Array.from(allowedHostnames),
    allowedOriginHostnames: Array.from(allowedOriginHostnames),
  });

  return {
    fetch: async (request: Request, envArg: Env, ctx: ExecutionContext) => {
      const isReadTool = await detectReadToolCall(request);
      if (isReadTool) {
        const caller = await resolveAuthorizedCaller(env, request);
        if (caller.ok && !caller.value.effectiveScopes.includes("pocketcircle:read")) {
          return bearerAuthChallengeResponse(
            new OAuthError(
              OAuthErrorCode.InsufficientScope,
              "The access token does not have required scope pocketcircle:read",
            ),
            { requiredScopes: ["pocketcircle:read"] },
          );
        }
      }
      const isWriteTool = await detectWriteToolCall(request);
      if (isWriteTool) {
        const caller = await resolveAuthorizedCaller(env, request);
        if (caller.ok && !caller.value.effectiveScopes.includes("pocketcircle:write")) {
          return bearerAuthChallengeResponse(
            new OAuthError(
              OAuthErrorCode.InsufficientScope,
              "The access token does not have required scope pocketcircle:write",
            ),
            { requiredScopes: ["pocketcircle:write"] },
          );
        }
        if (caller.ok) {
          const withinLimit = await assertMcpWriteWithinRateLimit(envArg, caller.value.grantId);
          if (!withinLimit.ok) {
            return new Response(JSON.stringify({ error: "rate_limited" }), {
              status: 429,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      }
      return mcpHandler(request, envArg, ctx);
    },
  } satisfies ExportedHandler<Env>;
}
