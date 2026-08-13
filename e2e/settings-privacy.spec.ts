import { establishE2ESession, expect, test } from "./fixtures.js";

/**
 * TRUE-E2E (ADR 0019 / #266): a newly bootstrapped User has analytics on after
 * onboarding and can turn it off in Settings → Privacy. Throwaway context so the
 * opt-out cannot clobber the worker session used by other specs.
 */
test("a new user's analytics switch is on after onboarding and can be turned off", async ({
  browser,
  baseURL,
}) => {
  const resolvedBase = typeof baseURL === "string" && baseURL ? baseURL : "http://127.0.0.1:5173";
  const email = `e2e+analytics-${Date.now()}@example.com`;

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route(/posthog\.com/i, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' }),
    );
    await establishE2ESession(page, { baseURL: resolvedBase, email, name: "Analytics User" });
    await page.goto(`${resolvedBase}/settings`);

    const analyticsSwitch = page.getByRole("switch", { name: /share product analytics/i });
    await expect(analyticsSwitch).toBeVisible();
    await expect(analyticsSwitch).toHaveAttribute("aria-checked", "true");

    await analyticsSwitch.click();
    await expect(page.getByText("Privacy preference updated.")).toBeVisible();
    await expect(analyticsSwitch).toHaveAttribute("aria-checked", "false");

    await page.reload();
    await expect(page.getByRole("switch", { name: /share product analytics/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  } finally {
    await context.close();
  }
});
