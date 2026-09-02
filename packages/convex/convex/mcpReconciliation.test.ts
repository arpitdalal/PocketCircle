/**
 * MCP cross-store reconciliation (#330): Convex-first revoke stays blocked,
 * Worker cleanup retries with backoff/exhaustion, orphan sweep, concurrency.
 */

import {
  MCP_WORKER_CLEANUP_INITIAL_BACKOFF_MS,
  MCP_WORKER_CLEANUP_MAX_ATTEMPTS,
  verifyMcpRevocation,
} from "@pocketcircle/domain";
import { HttpResponse, http } from "@pocketcircle/mocks";
import { server } from "@pocketcircle/mocks/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActiveMcpGrant } from "../test/mcp.js";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { seedOwnedCircle, seedPersonalCircleOwner } from "../test/seed.js";
import { enableSentryReporting, sentryNodeSdk } from "../test/sentry-boundary.js";
import { internal } from "./_generated/api.js";
import {
  activateMcpGrant,
  authorizeMcpGrant,
  createPendingMcpGrant,
  revokeMcpGrant,
} from "./mcpGrant.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
const CLIENT = "https://mcp-client.example/client.json";
const WORKER_ORIGIN = "https://mcp-worker.test";
const SECRET = "test-mcp-worker-secret";

beforeEach(() => {
  vi.stubEnv("MCP_WORKER_HMAC_SECRET", SECRET);
  vi.stubEnv("MCP_WORKER_ORIGIN", WORKER_ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  server.resetHandlers();
});

function stubWorkerRevoke(handler: (body: unknown) => Response | Promise<Response>) {
  server.use(
    http.post(`${WORKER_ORIGIN}/internal/revoke`, async ({ request }) => {
      return handler(await request.json());
    }),
  );
}

async function seedOwnerWithCircle(t: ReturnType<typeof convexTest>) {
  const ada = await t.run((ctx) =>
    seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
  );
  const circle = await t.run((ctx) => seedOwnedCircle(ctx, ada.owner, { name: "Trip" }));
  return { ada, circle };
}

describe("MCP Worker cleanup reconciliation", () => {
  it("keeps authz blocked after Convex revoke while Worker cleanup is pending", async () => {
    const t = convexTest(schema, modules);
    const { ada, circle } = await seedOwnerWithCircle(t);
    const grant = await createActiveMcpGrant(t, {
      userId: ada.userId,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT,
      workerGrantId: "worker-grant-1",
    });

    stubWorkerRevoke(() => HttpResponse.json({ error: "down" }, { status: 503 }));

    await mutateAndDrain(t, () => t.run((ctx) => revokeMcpGrant(ctx, { grantId: grant._id })));

    const denied = await t.run((ctx) =>
      authorizeMcpGrant(ctx, {
        grantId: grant._id,
        effectiveScopes: ["pocketcircle:read"],
        requiredScope: "pocketcircle:read",
      }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.denial).toMatchObject({ kind: "grant_unavailable", status: "revoked" });
    }

    const row = await t.run((ctx) => ctx.db.get(grant._id));
    expect(row?.workerCleanupStatus).toBe("pending_revoke");
    expect((row?.workerCleanupAttempts ?? 0) >= 1).toBe(true);
  });

  it("retries Worker cleanup until success and marks completed", async () => {
    const t = convexTest(schema, modules);
    const { ada, circle } = await seedOwnerWithCircle(t);
    const grant = await createActiveMcpGrant(t, {
      userId: ada.userId,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT,
      workerGrantId: "worker-grant-1",
    });

    let calls = 0;
    stubWorkerRevoke(async (body) => {
      calls += 1;
      if (calls === 1) {
        return HttpResponse.json({ error: "busy", retryable: true }, { status: 503 });
      }
      expect(body).toMatchObject({ revocationToken: expect.any(String) });
      await t.mutation(internal.mcpApproval.completeRevocationFromWorker, {
        grantId: String(grant._id),
        workerGrantId: "worker-grant-1",
        principalId: grant.principalId,
      });
      return HttpResponse.json({ revoked: true });
    });

    vi.useFakeTimers();
    try {
      await t.run((ctx) => revokeMcpGrant(ctx, { grantId: grant._id }));
      await t.finishAllScheduledFunctions(() => {
        vi.advanceTimersByTime(200);
      });
      expect(calls).toBe(1);
      expect((await t.run((ctx) => ctx.db.get(grant._id)))?.workerCleanupAttempts).toBe(1);

      vi.advanceTimersByTime(MCP_WORKER_CLEANUP_INITIAL_BACKOFF_MS + 1);
      await t.finishAllScheduledFunctions(() => {
        vi.advanceTimersByTime(200);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(calls).toBe(2);
    expect((await t.run((ctx) => ctx.db.get(grant._id)))?.workerCleanupStatus).toBe("completed");
  });

  it("exhausts bounded retries and reports a safe terminal failure", async () => {
    enableSentryReporting();
    const t = convexTest(schema, modules);
    const { ada, circle } = await seedOwnerWithCircle(t);
    const grant = await createActiveMcpGrant(t, {
      userId: ada.userId,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT,
      workerGrantId: "worker-grant-1",
    });

    stubWorkerRevoke(() =>
      HttpResponse.json(
        { error: "worker_cleanup_unavailable", secret: "should-not-log", amount: "$12.34" },
        { status: 503 },
      ),
    );

    vi.useFakeTimers();
    try {
      await t.run((ctx) => revokeMcpGrant(ctx, { grantId: grant._id }));
      for (let attempt = 0; attempt < MCP_WORKER_CLEANUP_MAX_ATTEMPTS; attempt++) {
        await t.finishAllScheduledFunctions(() => {
          vi.advanceTimersByTime(200);
        });
        if (attempt + 1 < MCP_WORKER_CLEANUP_MAX_ATTEMPTS) {
          vi.advanceTimersByTime(MCP_WORKER_CLEANUP_INITIAL_BACKOFF_MS * 2 ** attempt + 1);
        }
      }
      await t.finishAllScheduledFunctions(() => {
        vi.advanceTimersByTime(200);
      });
    } finally {
      vi.useRealTimers();
    }

    const row = await t.run((ctx) => ctx.db.get(grant._id));
    expect(row?.workerCleanupStatus).toBe("exhausted");
    expect(row?.workerCleanupAttempts).toBe(MCP_WORKER_CLEANUP_MAX_ATTEMPTS);
    expect(row?.workerCleanupLastError).toBe("worker_http_503");

    const denied = await t.run((ctx) =>
      authorizeMcpGrant(ctx, {
        grantId: grant._id,
        effectiveScopes: ["pocketcircle:read"],
        requiredScope: "pocketcircle:read",
      }),
    );
    expect(denied.ok).toBe(false);

    expect(sentryNodeSdk.captureEvent).toHaveBeenCalled();
    const [event] = sentryNodeSdk.captureEvent.mock.calls[0] ?? [];
    expect(event).toMatchObject({ message: "mcp_worker_cleanup_exhausted" });
  });

  it("orphan sweep completes revoked rows with no Worker grant id", async () => {
    const t = convexTest(schema, modules);
    const { ada, circle } = await seedOwnerWithCircle(t);
    const grant = await createActiveMcpGrant(t, {
      userId: ada.userId,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT,
      workerGrantId: "worker-grant-1",
    });
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.patch(grant._id, {
        status: "revoked",
        revokedAt: now,
        updatedAt: now,
        workerGrantId: undefined,
        workerCleanupStatus: "pending_revoke",
        workerCleanupAttempts: 0,
        workerCleanupNextAttemptAt: now,
      });
    });

    const processed = await t.mutation(internal.mcpReconciliation.reconcilePendingWorkerCleanups, {
      now,
    });
    expect(processed).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(grant._id)))?.workerCleanupStatus).toBe("completed");
  });

  it("orphan sweep backfills legacy pending_revoke without nextAttemptAt", async () => {
    const t = convexTest(schema, modules);
    const { ada, circle } = await seedOwnerWithCircle(t);
    const grant = await createActiveMcpGrant(t, {
      userId: ada.userId,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT,
      workerGrantId: "worker-grant-1",
    });
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.patch(grant._id, {
        status: "revoked",
        revokedAt: now,
        updatedAt: now,
        workerCleanupStatus: "pending_revoke",
        workerCleanupAttempts: 0,
        workerCleanupNextAttemptAt: undefined,
      });
    });

    let called = false;
    stubWorkerRevoke(async () => {
      called = true;
      await t.mutation(internal.mcpApproval.completeRevocationFromWorker, {
        grantId: String(grant._id),
        workerGrantId: "worker-grant-1",
        principalId: grant.principalId,
      });
      return HttpResponse.json({ revoked: true });
    });

    await mutateAndDrain(t, () =>
      t.mutation(internal.mcpReconciliation.reconcilePendingWorkerCleanups, { now }),
    );

    expect(called).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(grant._id)))?.workerCleanupStatus).toBe("completed");
  });

  it("orphan sweep enqueues due pending_revoke Worker cleanups", async () => {
    const t = convexTest(schema, modules);
    const { ada, circle } = await seedOwnerWithCircle(t);
    const grant = await createActiveMcpGrant(t, {
      userId: ada.userId,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT,
      workerGrantId: "worker-grant-1",
    });
    const now = Date.now();

    vi.stubEnv("MCP_WORKER_ORIGIN", "");
    await t.run((ctx) => revokeMcpGrant(ctx, { grantId: grant._id, now }));

    let called = false;
    vi.stubEnv("MCP_WORKER_ORIGIN", WORKER_ORIGIN);
    stubWorkerRevoke(async () => {
      called = true;
      await t.mutation(internal.mcpApproval.completeRevocationFromWorker, {
        grantId: String(grant._id),
        workerGrantId: "worker-grant-1",
        principalId: grant.principalId,
      });
      return HttpResponse.json({ revoked: true });
    });

    await mutateAndDrain(t, () =>
      t.mutation(internal.mcpReconciliation.reconcilePendingWorkerCleanups, { now }),
    );

    expect(called).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(grant._id)))?.workerCleanupStatus).toBe("completed");
  });

  it("concurrent revoke wins over activation; dual cleanup cannot reactivate", async () => {
    const t = convexTest(schema, modules);
    const { ada, circle } = await seedOwnerWithCircle(t);
    const pending = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: CLIENT,
        clientKind: "cimd",
        redirectUri: "https://mcp-client.example/callback",
        scopes: ["pocketcircle:read"],
        allowedCircleIds: [circle.circleId],
      }),
    );
    if (!pending.ok) {
      throw new Error(pending.error);
    }

    const [revokedA, revokedB] = await Promise.all([
      t.run((ctx) => revokeMcpGrant(ctx, { grantId: pending.value._id })),
      t.run((ctx) => revokeMcpGrant(ctx, { grantId: pending.value._id })),
    ]);
    expect(revokedA.ok).toBe(true);
    expect(revokedB.ok).toBe(true);

    const activated = await t.run((ctx) =>
      activateMcpGrant(ctx, {
        grantId: pending.value._id,
        workerGrantId: "worker-late",
        principalId: pending.value.principalId,
      }),
    );
    expect(activated.ok).toBe(false);

    const [first, second] = await Promise.all([
      t.mutation(internal.mcpApproval.completeRevocationFromWorker, {
        grantId: String(pending.value._id),
        workerGrantId: "worker-late",
        principalId: pending.value.principalId,
      }),
      t.mutation(internal.mcpApproval.completeRevocationFromWorker, {
        grantId: String(pending.value._id),
        workerGrantId: "worker-late",
        principalId: pending.value.principalId,
      }),
    ]);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);

    const row = await t.run((ctx) => ctx.db.get(pending.value._id));
    expect(row?.status).toBe("revoked");
  });

  it("retries once with previous HMAC on Worker 400 without burning budget", async () => {
    const t = convexTest(schema, modules);
    const { ada, circle } = await seedOwnerWithCircle(t);
    const grant = await createActiveMcpGrant(t, {
      userId: ada.userId,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT,
      workerGrantId: "worker-grant-1",
    });
    vi.stubEnv("MCP_WORKER_HMAC_SECRET_PREVIOUS", "previous-mcp-worker-secret");

    let calls = 0;
    stubWorkerRevoke(async () => {
      calls += 1;
      if (calls === 1) {
        return HttpResponse.json({ error: "invalid_revocation_token" }, { status: 400 });
      }
      await t.mutation(internal.mcpApproval.completeRevocationFromWorker, {
        grantId: String(grant._id),
        workerGrantId: "worker-grant-1",
        principalId: grant.principalId,
      });
      return HttpResponse.json({ revoked: true });
    });

    await mutateAndDrain(t, () => t.run((ctx) => revokeMcpGrant(ctx, { grantId: grant._id })));

    expect(calls).toBe(2);
    const row = await t.run((ctx) => ctx.db.get(grant._id));
    expect(row?.workerCleanupStatus).toBe("completed");
    expect(row?.workerCleanupAttempts ?? 0).toBe(0);
  });

  it("backfills then paginates legacy pending_revoke past the first page", async () => {
    const t = convexTest(schema, modules);
    const { ada, circle } = await seedOwnerWithCircle(t);
    const now = Date.now();
    const grants = [];
    for (let i = 0; i < 3; i += 1) {
      const grant = await createActiveMcpGrant(t, {
        userId: ada.userId,
        circleIds: [circle.circleId],
        scopes: ["pocketcircle:read"],
        clientId: `${CLIENT}#legacy-${i}`,
        workerGrantId: `worker-grant-legacy-${i}`,
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(grant._id, {
          status: "revoked",
          revokedAt: now,
          updatedAt: now,
          workerCleanupStatus: "pending_revoke",
          workerCleanupAttempts: 0,
          workerCleanupNextAttemptAt: undefined,
        });
      });
      grants.push(grant);
    }

    stubWorkerRevoke(async (body) => {
      expect(body).toMatchObject({ revocationToken: expect.any(String) });
      const token =
        body && typeof body === "object" && "revocationToken" in body ? body.revocationToken : null;
      expect(typeof token).toBe("string");
      if (typeof token !== "string") {
        throw new Error("missing revocation token");
      }
      const payload = await verifyMcpRevocation(token, SECRET);
      expect(payload).toBeTruthy();
      if (!payload) {
        throw new Error("invalid revocation token");
      }
      await t.mutation(internal.mcpApproval.completeRevocationFromWorker, {
        grantId: payload.grantId,
        workerGrantId: payload.workerGrantId,
        principalId: payload.principalId,
      });
      return HttpResponse.json({ revoked: true });
    });

    await mutateAndDrain(t, () =>
      t.mutation(internal.mcpReconciliation.reconcilePendingWorkerCleanups, { now, limit: 1 }),
    );

    for (const grant of grants) {
      expect((await t.run((ctx) => ctx.db.get(grant._id)))?.workerCleanupStatus).toBe("completed");
    }
  });

  it("logs only safe operational identifiers during cleanup failure", async () => {
    const t = convexTest(schema, modules);
    const { ada, circle } = await seedOwnerWithCircle(t);
    const grant = await createActiveMcpGrant(t, {
      userId: ada.userId,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT,
      workerGrantId: "worker-grant-1",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    stubWorkerRevoke(() =>
      HttpResponse.json(
        { error: "fail", email: "ada@example.com", url: "https://evil.example/token" },
        { status: 500 },
      ),
    );

    await mutateAndDrain(t, () => t.run((ctx) => revokeMcpGrant(ctx, { grantId: grant._id })));

    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls]
      .flat()
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ");
    expect(logged).toContain(String(grant._id));
    expect(logged).not.toMatch(/ada@example\.com|evil\.example/i);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
