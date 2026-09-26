import { APEX_ORIGIN, LOCAL_APP_ORIGIN, LOCAL_APP_TWIN_ORIGIN } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { registerEmailWorkpool } from "../test/registerEmailWorkpool.js";
import { seedPersonalCircleOwner } from "../test/seed.js";
import { api, internal } from "./_generated/api.js";
import { authComponentConfig, authRuntimeConfig, createAuth } from "./auth.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

/** The Better Auth context `createAuth` resolves, which the origin check reads. */
type AuthContext = Awaited<ReturnType<ReturnType<typeof createAuth>["$context"]>>;

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

  it("sets select_account on the Google provider when credentials are configured", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");

    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      const auth = createAuth(ctx);
      const context = await auth.$context;
      expect(context.options.socialProviders?.google?.prompt).toBe("select_account");
    });
  });

  it("enables verified Account Deletion and stashes the mapped verification token", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    vi.stubEnv("E2E_TEST_AUTH", "1");
    vi.stubEnv("SITE_URL", "https://app.example.com");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("RESEND_FROM_EMAIL", "PocketCircle <onboarding@example.com>");

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
      siteUrl: LOCAL_APP_ORIGIN,
      verbose: true,
      migrationAppOrigin: null,
    });
    expect(authRuntimeConfig(LOCAL_APP_TWIN_ORIGIN)).toEqual({
      siteUrl: LOCAL_APP_TWIN_ORIGIN,
      verbose: true,
      migrationAppOrigin: null,
    });
    expect(authRuntimeConfig("https://app.example.com/")).toEqual({
      siteUrl: "https://app.example.com",
      verbose: false,
      migrationAppOrigin: null,
    });
  });

  it("normalizes a declared migration app origin to a bare origin", () => {
    expect(
      authRuntimeConfig(APEX_ORIGIN, "https://app.example.com/invite/abc").migrationAppOrigin,
    ).toBe("https://app.example.com");
  });

  it("rejects a migration app origin that is not an origin", () => {
    expect(() => authRuntimeConfig(APEX_ORIGIN, "app.example.com")).toThrow();
  });
});

describe("createAuth trusted origins", () => {
  /** The app origin the ADR 0035 cutover moves the SPA to. */
  const APP_ORIGIN_UNDER_MIGRATION = "https://app.example.com";

  /**
   * Stubs the deployment env `createAuth` reads, then asserts against the Better
   * Auth options it really builds. Assertions run inside a convex-test run because
   * its return value has to be Convex-serializable and the auth context is not.
   */
  async function expectAuthContext(
    env: { siteUrl: string; migrationAppOrigin?: string },
    assert: (context: AuthContext) => void,
  ) {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    vi.stubEnv("SITE_URL", env.siteUrl);
    vi.stubEnv("MIGRATION_APP_ORIGIN", env.migrationAppOrigin);

    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      assert(await createAuth(ctx).$context);
    });
  }

  /**
   * Exact match on the merged list, because membership in it *is* the accept/reject
   * decision: the component's CORS router answers `Access-Control-Allow-Origin` for
   * a listed origin only, so sign-in from an origin absent here fails CORS. SITE_URL
   * arrives via the crossDomain plugin, which appends after the origins declared
   * here — hence the order.
   */
  it("trusts SITE_URL and the declared migration app origin, and nothing else", async () => {
    await expectAuthContext(
      { siteUrl: APEX_ORIGIN, migrationAppOrigin: APP_ORIGIN_UNDER_MIGRATION },
      (context) => {
        expect(context.options.trustedOrigins).toEqual([APP_ORIGIN_UNDER_MIGRATION, APEX_ORIGIN]);
      },
    );
  });

  it("trusts only SITE_URL when no second origin is declared", async () => {
    await expectAuthContext({ siteUrl: APEX_ORIGIN }, (context) => {
      expect(context.options.trustedOrigins).toEqual([APEX_ORIGIN]);
    });
  });

  it("declares no second origin when it is already SITE_URL", async () => {
    await expectAuthContext(
      { siteUrl: APEX_ORIGIN, migrationAppOrigin: APEX_ORIGIN },
      (context) => {
        expect(context.options.trustedOrigins).toEqual([APEX_ORIGIN]);
      },
    );
  });

  it("also trusts the localhost twin when SITE_URL is 127.0.0.1", async () => {
    await expectAuthContext({ siteUrl: LOCAL_APP_ORIGIN }, (context) => {
      expect(context.options.trustedOrigins).toEqual([LOCAL_APP_TWIN_ORIGIN, LOCAL_APP_ORIGIN]);
    });
  });
});

describe("authComponentConfig", () => {
  it("wires verbose component logging only for local app origins", () => {
    expect(authComponentConfig(LOCAL_APP_TWIN_ORIGIN).verbose).toBe(true);
    expect(authComponentConfig("https://app.example.com").verbose).toBe(false);
  });
});
