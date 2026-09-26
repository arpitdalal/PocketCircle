import { type AuthFunctions, createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { requireRunMutationCtx } from "@convex-dev/better-auth/utils";
import { isLoopbackHostname, LOCAL_APP_ORIGIN, loopbackTrustedOrigins } from "@pocketcircle/domain";
import { betterAuth } from "better-auth";
import { components, internal } from "./_generated/api.js";
import type { DataModel, Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { parseBetterAuthMappedUser } from "./accountDeletionAuth.js";
import { finalizeOnUserDelete } from "./accountDeletionFinalize.js";
import authConfig from "./auth.config.js";
import { emailPool } from "./email.js";
import { createUserWithPersonalCircle, syncUserEmail } from "./model.js";

/**
 * Better Auth + Convex wiring (ADR 0002). Auth runs as a Convex component; this
 * deployment hosts the auth routes and mints a Convex JWT (the `convex` plugin).
 * The web app is a separate origin (SPA on the app domain), so the
 * `crossDomain` plugin trusts the app's SITE_URL.
 *
 * Required deployment env vars: SITE_URL (the app origin), GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET, BETTER_AUTH_SECRET, RESEND_API_KEY, RESEND_FROM_EMAIL.
 * CONVEX_SITE_URL is provided by Convex automatically and is where the auth
 * routes live.
 *
 * MIGRATION_APP_ORIGIN widens the trusted origins for the ADR 0035 cutover
 * window (#409): the SPA is served from the app origin while SITE_URL still
 * names the apex, so both have to be trusted for sign-in to work on whichever
 * one a User lands on. Unset means a single origin, which is what local, E2E,
 * and post-migration deployments run. Deploying the app origin is then not
 * itself the cutover — the DNS swap and the SITE_URL flip stay separate,
 * independently verifiable steps. Remove it once SITE_URL names the app origin;
 * that is the `migrationAppOrigin` value, the read in {@link createAuth}, the
 * second entry in the trusted-origins list there, the `declaredOrigin` call and
 * its parameter below, and the README section. `declaredOrigin` and
 * `BARE_ORIGIN` are not migration-specific — SITE_URL is checked with the same
 * helper — so they stay.
 *
 * E2E-only: when `E2E_TEST_AUTH=1` (set ONLY on ephemeral CI/self-hosted
 * deployments, NEVER in production — ADR 0019), email+password sign-in is also
 * enabled so Playwright can mint a real, backend-trusted session without driving
 * Google OAuth (which it cannot automate). Production stays Google-only (ADR 0002):
 * the flag is absent there, so this path does not exist on the prod deployment.
 */
const authFunctions: AuthFunctions = internal.auth;

/**
 * `scheme://host[:port]` and nothing else. Patterns are refused deliberately:
 * Better Auth reads `https://*.example.com` as a wildcard that matches any
 * subdomain — including as a `callbackURL` destination, which would hand a live
 * one-time session token to whatever host matched — while the component's CORS
 * router matches exact origins only, so the same string would also break sign-in
 * from the origin it was meant to allow. A comma-separated list is refused for
 * the same reason: Better Auth's own `BETTER_AUTH_TRUSTED_ORIGINS` splits on
 * commas, this value must not.
 */
const BARE_ORIGIN = /^https?:\/\/(?:\[[0-9a-f:.]+\]|[^:/?#*\s,]+)(?::\d+)?\/?$/i;

/**
 * The origin a deployment declares, or a throw naming the variable that is wrong.
 * This runs when the auth routes initialise, per request, not at deploy — so a
 * malformed value surfaces as every auth call failing, loudly, rather than quietly
 * leaving an origin untrusted.
 */
function declaredOrigin(name: string, value: string) {
  if (!BARE_ORIGIN.test(value)) {
    throw new Error(
      `${name} must be a single origin such as https://app.example.com, not a pattern or a list: ${value}`,
    );
  }
  return new URL(value).origin;
}

export function authRuntimeConfig(
  siteUrlValue: string | undefined,
  migrationAppOriginValue?: string,
) {
  // SITE_URL goes through the same check as the origin declared beside it. It is the
  // origin better-auth trusts and the base a relative sign-in callback resolves
  // against, so a pattern there is the hazard above rather than a shorthand.
  const siteUrl = declaredOrigin("SITE_URL", siteUrlValue ?? LOCAL_APP_ORIGIN);
  const verbose = isLoopbackHostname(new URL(siteUrl).hostname);
  const migrationAppOrigin = migrationAppOriginValue
    ? declaredOrigin("MIGRATION_APP_ORIGIN", migrationAppOriginValue)
    : null;
  return { siteUrl, verbose, migrationAppOrigin };
}

export function authComponentConfig(siteUrlValue: string | undefined) {
  return {
    authFunctions,
    // The component's verbose mode logs auth request/response headers. Keep that
    // useful signal for local development only; production origins must never emit it.
    verbose: authRuntimeConfig(siteUrlValue).verbose,
    triggers: {
      user: {
        onCreate: async (ctx, authUser) => {
          const userId = await createUserWithPersonalCircle(ctx, {
            email: authUser.email,
            displayName: authUser.name,
            image: authUser.image ?? undefined,
          });
          await authComponent.setUserId(ctx, authUser._id, userId);
          await emailPool.enqueueAction(
            ctx,
            internal.email.sendWelcomeEmail,
            { userId },
            {
              onComplete: internal.email.onWelcomeRunComplete,
              context: { userId },
            },
          );
        },
        onUpdate: async (ctx, authUser) => {
          if (!authUser.userId) {
            return;
          }
          const userId = ctx.db.normalizeId("users", authUser.userId);
          if (!userId) {
            return;
          }
          await syncUserEmail(ctx, userId, authUser.email);
        },
        onDelete: async (ctx, authUser) => {
          // Static import from a cycle-free module — mutations cannot use runtime
          // `await import()` (dynamic imports are for actions).
          await finalizeOnUserDelete(ctx, authUser);
        },
      },
    },
  } satisfies NonNullable<Parameters<typeof createClient<DataModel>>[1]>;
}

export const authComponent = createClient<DataModel>(
  components.betterAuth,
  authComponentConfig(process.env.SITE_URL),
);

// Component trigger functions. `onCreate` runs in the OAuth callback and creates
// the PocketCircle User + Personal Circle (PRD stories 1, 3), then stores the app
// user id on the auth-user mapping. `onUpdate` syncs Google Account Email only
// (ADR 0024); Display Name propagation is in-app via `setUserDisplayName`.
// `onDelete` finalizes Account Deletion (USR-3 / ADR 0029).
export const { onCreate, onUpdate, onDelete } = authComponent.triggersApi();

export const { getAuthUser } = authComponent.clientApi();

// E2E-only auth bypass (ADR 0019). Enabled solely on ephemeral test deployments via
// E2E_TEST_AUTH; never set in production, so production stays Google-only (ADR 0002).
const e2eTestAuth = process.env.E2E_TEST_AUTH === "1";

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const authRuntime = authRuntimeConfig(process.env.SITE_URL, process.env.MIGRATION_APP_ORIGIN);
  // Browsers treat the two loopback names as different origins. Vite may open
  // either one; trust the twin so local Google sign-in CORS matches SITE_URL.
  const [siteUrl, loopbackTwin] = loopbackTrustedOrigins(authRuntime.siteUrl);
  // crossDomain contributes SITE_URL to trustedOrigins; this list is every other
  // origin auth trusts. Deduplicated against SITE_URL and itself, so an origin
  // that is already trusted — the apex before the cutover, or the loopback twin
  // locally — is not listed twice.
  const extraTrustedOrigins = [...new Set([authRuntime.migrationAppOrigin, loopbackTwin])].filter(
    (origin): origin is string => typeof origin === "string" && origin !== siteUrl,
  );
  return betterAuth({
    baseURL: process.env.CONVEX_SITE_URL,
    database: authComponent.adapter(ctx),
    account: { accountLinking: { enabled: true } },
    // E2E-only (ADR 0019): a flag-gated credentials path so Playwright can mint a
    // session without Google. Eliminated in production (E2E_TEST_AUTH is unset there).
    ...(e2eTestAuth ? { emailAndPassword: { enabled: true } } : {}),
    // Google-only sign-in (ADR 0002).
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        prompt: "select_account",
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        sendDeleteAccountVerification: async ({
          user,
          token,
        }: {
          user: unknown;
          token: string;
        }) => {
          const mapped = parseBetterAuthMappedUser(user);
          const runCtx = requireRunMutationCtx(ctx);
          await runCtx.runMutation(internal.accountDeletion.enqueueDeletionVerificationEmail, {
            mappedUserId: mapped.userId,
            email: mapped.email,
            displayName: mapped.name ?? mapped.email,
            token,
          });
        },
      },
    },
    ...(extraTrustedOrigins.length > 0 ? { trustedOrigins: extraTrustedOrigins } : {}),
    plugins: [convex({ authConfig }), crossDomain({ siteUrl })],
  });
};

/** The PocketCircle User for the current auth identity, or null. */
export async function getCurrentUserOrNull(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"users"> | null> {
  // @convex-dev/better-auth@0.12.3 (`src/client/create-client.ts`): `safeGetAuthUser`
  // returns undefined when there is no Convex identity or no valid session/user row.
  // The throwing `getAuthUser` wraps that with `ConvexError("Unauthenticated")` — use
  // the safe API so only real component/query failures hit the catch below.
  let authUser: Awaited<ReturnType<typeof authComponent.safeGetAuthUser>>;
  try {
    authUser = await authComponent.safeGetAuthUser(ctx);
  } catch (error) {
    // Unexpected component failure: degrade to signed-out but leave a trace
    // (upgrade to Sentry capture when OBS-1 lands). Our own users-table read
    // below is deliberately OUTSIDE this catch — a DB failure there must
    // propagate, not masquerade as "signed out".
    console.error("safeGetAuthUser failed unexpectedly", error);
    return null;
  }
  if (!authUser?.userId) {
    return null;
  }
  const userId = ctx.db.normalizeId("users", authUser.userId);
  return userId ? await ctx.db.get(userId) : null;
}

/** Throws unless the request is from a bootstrapped PocketCircle User. */
export async function requireCurrentUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await getCurrentUserOrNull(ctx);
  if (!user) {
    throw new Error("Not authenticated");
  }
  return user;
}
