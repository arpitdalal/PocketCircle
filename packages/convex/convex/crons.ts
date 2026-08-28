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

export default crons;
