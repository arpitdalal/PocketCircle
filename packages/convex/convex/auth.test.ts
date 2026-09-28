import {
  APEX_ORIGIN,
  APP_ORIGIN,
  LOCAL_APP_ORIGIN,
  LOCAL_APP_TWIN_ORIGIN,
} from "@pocketcircle/domain";
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
    });
    expect(authRuntimeConfig(LOCAL_APP_TWIN_ORIGIN)).toEqual({
      siteUrl: LOCAL_APP_TWIN_ORIGIN,
      verbose: true,
    });
    expect(authRuntimeConfig("https://app.example.com/")).toEqual({
      siteUrl: "https://app.example.com",
      verbose: false,
    });
  });

  it.each([
    ["a wildcard", "https://*.example.com"],
    ["a scheme-less value", "app.example.com"],
    ["a comma-separated list", "https://a.example.com,https://b.example.com"],
    ["a path", "https://app.example.com/signin"],
    // Reads as one host, parses as another — a trust decision must not be rewritten
    // on its way in.
    ["credentials in the host", "https://app.example.com@evil.example"],
    ["a percent-encoded host", "https://ex%41mple.com"],
    // `\` is read as `/` by the URL parser, so the value parses to a shorter origin
    // than it reads as.
    ["a backslash in the host", "https://evil.example\\app.example.com"],
    // The cross-domain flow ends in a redirect carrying a live session token.
    ["a plaintext public origin", "http://app.example.com"],
    // Set-but-empty is a mistake to report, not an absent variable to fall back from.
    // With SITE_URL the only origin there is no fallback to widen to, so this takes
    // *all* auth down rather than silently narrowing it — which is the right outcome,
    // and the reason it is still worth a case of its own.
    ["an empty value", ""],
  ])("rejects %s as SITE_URL", (_label, value) => {
    expect(() => authRuntimeConfig(value)).toThrow(/SITE_URL/);
  });

  it("accepts a plaintext origin on loopback, which is what local dev and E2E use", () => {
    expect(authRuntimeConfig(LOCAL_APP_ORIGIN).siteUrl).toBe(LOCAL_APP_ORIGIN);
    expect(authRuntimeConfig(LOCAL_APP_TWIN_ORIGIN).siteUrl).toBe(LOCAL_APP_TWIN_ORIGIN);
  });
});

describe("createAuth trusted origins", () => {
  /**
   * Stubs the deployment env `createAuth` reads, then asserts against the Better
   * Auth options it really builds. Assertions run inside a convex-test run because
   * its return value has to be Convex-serializable and the auth context is not.
   */
  async function expectAuthContext(siteUrl: string, assert: (context: AuthContext) => void) {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    vi.stubEnv("SITE_URL", siteUrl);

    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      assert(await createAuth(ctx).$context);
    });
  }

  /**
   * Exact match on the merged list, because membership in it *is* the accept/reject
   * decision: the component's CORS router answers `Access-Control-Allow-Origin` for
   * a listed origin only, and Better Auth's origin check reads the same list, so
   * sign-in from an origin absent from it fails. SITE_URL arrives via the crossDomain
   * plugin, which appends after the origins declared here — hence the order. The
   * rejection direction is the exactness of the match: the app origin is absent from
   * it, so sign-in served from there fails.
   */
  it("accepts sign-in from SITE_URL alone, which is the one origin auth trusts", async () => {
    // SITE_URL is the app origin, which is the invariant this suite exists to pin: the
    // apex is the marketing Site's, so a test that passed the apex here would assert
    // the pre-cutover shape while claiming to be the settled one, and nothing in the
    // suite would notice SITE_URL being pointed back at it.
    await expectAuthContext(APP_ORIGIN, (context) => {
      expect(context.options.trustedOrigins).toEqual([APP_ORIGIN]);
      // No entry Better Auth would read as a pattern: its matcher honours
      // wildcards and the CORS router does not, so one entry could widen a trust
      // decision and break sign-in at the same time.
      expect(
        (context.options.trustedOrigins ?? []).filter((origin) => /[*?]/.test(origin)),
      ).toEqual([]);
    });
  });

  it("does not trust the apex, which serves the marketing Site and not the app", async () => {
    await expectAuthContext(APP_ORIGIN, (context) => {
      expect(context.options.trustedOrigins).not.toContain(APEX_ORIGIN);
    });
  });

  it("also trusts the localhost twin when SITE_URL is 127.0.0.1", async () => {
    await expectAuthContext(LOCAL_APP_ORIGIN, (context) => {
      expect(context.options.trustedOrigins).toEqual([LOCAL_APP_TWIN_ORIGIN, LOCAL_APP_ORIGIN]);
    });
  });

  it("names the loopback twin once when SITE_URL is the twin", async () => {
    await expectAuthContext(LOCAL_APP_TWIN_ORIGIN, (context) => {
      expect(context.options.trustedOrigins).toEqual([LOCAL_APP_ORIGIN, LOCAL_APP_TWIN_ORIGIN]);
    });
  });
});

describe("authComponentConfig", () => {
  it("wires verbose component logging only for local app origins", () => {
    expect(authComponentConfig(LOCAL_APP_TWIN_ORIGIN).verbose).toBe(true);
    expect(authComponentConfig("https://app.example.com").verbose).toBe(false);
  });
});
