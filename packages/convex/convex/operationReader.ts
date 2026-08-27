import type { QueryCtx } from "./_generated/server.js";

/** DB read surface shared domain ops / explicit-User guards may use. No auth, scheduler, or writes. */
export type OperationReader = Pick<QueryCtx, "db">;
