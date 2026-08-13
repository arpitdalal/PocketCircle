import {
  createIsolatedBrowserContext,
  establishE2ESession,
  expect,
  test,
  waitForScE2E,
} from "./fixtures.js";

/**
 * TRUE-E2E (ADR 0019) for USR-3 Account Deletion: request → emailed token →
 * matching-session verify → completion → protected queries no longer available.
 * Uses a throwaway context so deletion cannot strand the worker session.
 */
test("account deletion verifies, signs out, and blocks protected access", async ({
  browser,
  baseURL,
}) => {
  // Sign-up + request + verify + redirect exceeds the default 30s; the verify
  // heading wait alone allows 60s.
  test.setTimeout(120_000);

  const resolvedBase = typeof baseURL === "string" && baseURL ? baseURL : "http://127.0.0.1:5173";
  const email = `e2e+delete-${Date.now()}@example.com`;

  const context = await createIsolatedBrowserContext(browser);
  const page = await context.newPage();
  try {
    await establishE2ESession(page, { baseURL: resolvedBase, email, name: "Delete Me" });
    await page.goto(`${resolvedBase}/settings`);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: /export account data/i })).toHaveCount(0);
    await expect(page.getByText(/account export/i)).toHaveCount(0);
    await waitForScE2E(page);

    const phrase = page.getByLabel(/type delete my account/i);
    await phrase.fill("DELETE MY ACCOUNT");
    await page.getByRole("button", { name: /delete my account/i }).click();
    await expect(page.getByText(/check your email/i)).toBeVisible();

    const token = await page.evaluate(async () => {
      const helper = Reflect.get(globalThis, "__scE2E");
      if (typeof helper !== "object" || helper === null) {
        throw new Error("missing __scE2E");
      }
      const getToken = Reflect.get(helper, "getAccountDeletionToken");
      if (typeof getToken !== "function") {
        throw new Error("missing getAccountDeletionToken");
      }
      return Reflect.apply(getToken, helper, []);
    });
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    await page.goto(
      `${resolvedBase}/delete-account/verify?token=${encodeURIComponent(String(token))}`,
    );
    await expect(page.getByRole("heading", { name: /account deleted/i })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page).toHaveURL(/\/delete-account\/complete/);

    await page.goto(`${resolvedBase}/`);
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeVisible();

    // Session is truly gone: getSession reports null (not just a client redirect).
    await waitForScE2E(page);
    const sessionGone = await page.evaluate(async () => {
      const helper = Reflect.get(globalThis, "__scE2E");
      if (typeof helper !== "object" || helper === null) {
        return { ok: false, reason: "missing __scE2E" };
      }
      const getSession = Reflect.get(helper, "getSession");
      if (typeof getSession !== "function") {
        return { ok: false, reason: "missing getSession" };
      }
      const session = await Reflect.apply(getSession, helper, []);
      return { ok: true, session };
    });
    expect(sessionGone).toEqual({ ok: true, session: null });
  } finally {
    await context.close().catch(() => {});
  }
});
