import betterAuth from "@convex-dev/better-auth/convex.config";
import workpool from "@convex-dev/workpool/convex.config.js";
import { defineApp } from "convex/server";

// Better Auth runs as a Convex component (ADR 0002). Workpool gives email and
// Push handoffs bounded-concurrency retries — separate pools so a slow push
// provider cannot starve Invitation email (ADR 0033). Free-plan action ceiling
// is 20 across ALL pools; keep email + push sum under that.
const app = defineApp();
app.use(betterAuth);
app.use(workpool, { name: "emailWorkpool" });
app.use(workpool, { name: "pushWorkpool" });

export default app;
