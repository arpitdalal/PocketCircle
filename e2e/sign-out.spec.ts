import { createIsolatedBrowserContext, establishE2ESession, expect, test } from "./fixtures.js";

/**
 * TRUE-E2E (ADR 0019) regression guard for the sign-out wiring fixed in #132/#135.
 * Clicking Sign out runs the real `signOut` wrapper, and the user MUST end up signed
 * out at /signin — that holds via either path the fix defines, so we assert the
 * convergent outcome rather than which path fired:
 *   - success: the wrapper resolves, the session clears, and the reactive
 *     ProtectedLayout guard redirects (no bespoke routing); or
 *   - failure: the wrapper throws (it now surfaces Better Auth's resolved `{ error }`
 *     instead of swallowing it), and AccountMenu's catch logs + routes to /signin.
 * In this self-hosted cross-domain backend the sign-out fetch actually fails, so this
 * spec exercises the real #135 error path end to end — without the fix the user would
 * be stranded in the menu instead of landing here.
 *
 * Sign-out revokes the session, so this drives a throwaway user in its OWN anonymous
 * context rather than the per-worker `storageState`: tearing down that session can't
 * strand the other specs sharing the worker session. (Depending only on `browser`/
 * `baseURL` also means the worker auth fixture is never instantiated for this spec.)
 */
test("signing out clears the session and lands on /signin", async ({ browser, baseURL }) => {
  const resolvedBase = typeof baseURL === "string" && baseURL ? baseURL : "http://127.0.0.1:5173";
  const email = `e2e+signout-${Date.now()}@example.com`;

  const context = await createIsolatedBrowserContext(browser);
  const page = await context.newPage();
  try {
    await establishE2ESession(page, { baseURL: resolvedBase, email });
    await expect(page.getByRole("heading", { name: "Your circles" })).toBeVisible();

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();

    // Reactive redirect once the session actually clears (the sign-in screen, at /signin).
    await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
    await expect(page).toHaveURL(/\/signin$/);

    // Session is truly gone, not just a client redirect: deep-linking back into the
    // protected shell bounces to /signin instead of rendering the authenticated app.
    await page.goto(`${resolvedBase}/`);
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
  } finally {
    await context.close();
  }
});
