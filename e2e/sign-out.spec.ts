import { createIsolatedBrowserContext, establishE2ESession, expect, test } from "./fixtures.js";

/**
 * TRUE-E2E (ADR 0019) regression guard for the sign-out wiring fixed in #132/#135.
 * Clicking Sign out runs the real `signOut` wrapper, and the user MUST end up signed
 * out on the public homepage — that holds via either path the fix defines, so we
 * assert the convergent outcome rather than which path fired:
 *   - success: the wrapper resolves, the session clears, and the reactive
 *     ProtectedLayout shows the marketing homepage at `/`; or
 *   - failure: the wrapper throws (it now surfaces Better Auth's resolved `{ error }`
 *     instead of swallowing it), and AccountMenu's catch logs + routes to /signin
 *     (Continue with Google). In this self-hosted cross-domain backend the sign-out
 *     fetch often fails, so either signed-out landing is acceptable.
 *
 * Sign-out revokes the session, so this drives a throwaway user in its OWN anonymous
 * context rather than the per-worker `storageState`: tearing down that session can't
 * strand the other specs sharing the worker session. (Depending only on `browser`/
 * `baseURL` also means the worker auth fixture is never instantiated for this spec.)
 */
test("signing out clears the session and lands signed out", async ({ browser, baseURL }) => {
  const resolvedBase = typeof baseURL === "string" && baseURL ? baseURL : "http://127.0.0.1:5173";
  const email = `e2e+signout-${Date.now()}@example.com`;

  const context = await createIsolatedBrowserContext(browser);
  const page = await context.newPage();
  try {
    await establishE2ESession(page, { baseURL: resolvedBase, email });
    await expect(page.getByRole("heading", { name: "Your circles" })).toBeVisible();

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();

    await expect(page.getByRole("button", { name: /Continue with Google/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0);

    // Session is truly gone, not just a client redirect: revisiting `/` stays signed out.
    await page.goto(`${resolvedBase}/`);
    await expect(page.getByRole("button", { name: /Continue with Google/ }).first()).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === "/");
    await expect(page.getByRole("heading", { name: "PocketCircle" })).toBeVisible();
  } finally {
    await context.close();
  }
});
