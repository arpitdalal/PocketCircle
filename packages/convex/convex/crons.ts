import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Clean up expired MCP Worker replay-protection nonces hourly.
crons.interval(
  "cleanup-expired-mcp-worker-nonces",
  { hours: 1 },
  internal.mcpApproval.cleanupExpiredWorkerNonces,
  {},
);

// Clean up expired MCP approval tokens hourly.
crons.interval(
  "cleanup-expired-mcp-approval-tokens",
  { hours: 1 },
  internal.mcpApproval.cleanupExpiredApprovalTokens,
  {},
);

// Revoke pending MCP grants abandoned after the approval window.
crons.interval(
  "cleanup-expired-pending-mcp-grants",
  { hours: 1 },
  internal.mcpApproval.cleanupExpiredPendingMcpGrants,
  {},
);

export default crons;
