import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { registerEmailWorkpool } from "../test/registerEmailWorkpool.js";
import { seedPersonalCircleOwner } from "../test/seed.js";
import { api, internal } from "./_generated/api.js";
import { authComponentConfig, authRuntimeConfig, createAuth } from "./auth.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getCurrentUserOrNull (via users.getCurrentUser)", () => {
  // Step 3.2 (unexpected `safeGetAuthUser` throw → log + null): skipped — convex-test
  // cannot force a component failure without mocking `auth.ts` (ADR 0006).
  it("returns null without error logging when there is no session", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const user = await t.query(api.users.getCurrentUser, {});
    expect(user).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("createAuth", () => {
  it("starts without Google credentials so first local backend bootstrap can set them later", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");

    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      const auth = createAuth(ctx);
      await expect(auth.$context).resolves.toBeDefined();
    });
  });

  it("enables verified Account Deletion and stashes the mapped verification token", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    vi.stubEnv("E2E_TEST_AUTH", "1");
    vi.stubEnv("SITE_URL", "https://app.example.com");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("RESEND_FROM_EMAIL", "Spend Circle <onboarding@example.com>");

    const t = convexTest(schema, modules);
    registerEmailWorkpool(t);
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "wire@example.com",
        displayName: "Wire Me",
        onboarded: true,
      }),
    );

    await t.run(async (ctx) => {
      const auth = createAuth(ctx);
      const context = await auth.$context;
      expect(context.options.user?.deleteUser?.enabled).toBe(true);
      expect(context.options.user?.deleteUser?.sendDeleteAccountVerification).toEqual(
        expect.any(Function),
      );
      expect(context.options.trustedOrigins).toEqual(["https://app.example.com"]);
    });

    // Callback closes over Better Auth's HTTP runMutation ctx, which convex-test
    // MutationCtx cannot supply — exercise the same enqueue mutation it calls.
    await mutateAndDrain(t, () =>
      t.mutation(internal.accountDeletion.enqueueDeletionVerificationEmail, {
        mappedUserId: owner._id,
        email: owner.email,
        displayName: owner.email,
        token: "auth-wire-token",
      }),
    );

    await t.run(async (ctx) => {
      const stash = await ctx.db
        .query("e2eAccountDeletionTokens")
        .withIndex("by_user", (q) => q.eq("userId", owner._id))
        .unique();
      expect(stash?.token).toBe("auth-wire-token");
    });
  });
});

describe("authRuntimeConfig", () => {
  it("enables verbose auth logs only for the configured local origin", () => {
    expect(authRuntimeConfig(undefined)).toEqual({
      siteUrl: "http://127.0.0.1:5173",
      verbose: true,
    });
    expect(authRuntimeConfig("http://localhost:5173/")).toEqual({
      siteUrl: "http://localhost:5173",
      verbose: true,
    });
    expect(authRuntimeConfig("https://app.example.com/")).toEqual({
      siteUrl: "https://app.example.com",
      verbose: false,
    });
  });
});

describe("authComponentConfig", () => {
  it("wires verbose component logging only for local app origins", () => {
    expect(authComponentConfig("http://localhost:5173").verbose).toBe(true);
    expect(authComponentConfig("https://app.example.com").verbose).toBe(false);
  });
});
