import {
  createIsolatedBrowserContext,
  establishE2ESession,
  expect,
  openHome,
  test,
} from "./fixtures.js";

/**
 * TRUE-E2E Feature Announcement (#282). Uses throwaway Users (not the worker
 * storageState session) so acknowledgment from one scenario cannot hide the
 * card for another. Backdates `createdAt` so eligibility survives any
 * `eligibleBefore` at or after account creation time.
 */

/** Well before any campaign release cutoff — keeps E2E Users eligible. */
const ANNOUNCEMENT_ELIGIBLE_CREATED_AT = Date.parse("2020-01-01T00:00:00.000Z");
const ACTIVE_TITLE = /Connect PocketCircle to your AI assistant/i;

async function establishAnnouncementEligibleSession(
  page: import("@playwright/test").Page,
  opts: { baseURL: string; email: string; name: string },
) {
  await establishE2ESession(page, {
    ...opts,
    keepFeatureAnnouncements: true,
  });
  await page.evaluate(async (createdAt) => {
    const helper = Reflect.get(globalThis, "__scE2E");
    if (typeof helper !== "object" || helper === null) {
      throw new Error("missing __scE2E");
    }
    const backdate = Reflect.get(helper, "backdateCreatedAt");
    if (typeof backdate !== "function") {
      throw new Error("missing backdateCreatedAt");
    }
    await Reflect.apply(backdate, helper, [createdAt]);
  }, ANNOUNCEMENT_ELIGIBLE_CREATED_AT);
}

test("Feature Announcement CTA opens Connections and acknowledges the campaign", async ({
  browser,
  baseURL,
}, testInfo) => {
  const resolvedBase = typeof baseURL === "string" && baseURL ? baseURL : "http://127.0.0.1:5173";
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const context = await createIsolatedBrowserContext(browser);
  const page = await context.newPage();
  try {
    await establishAnnouncementEligibleSession(page, {
      baseURL: resolvedBase,
      email: `e2e+ann-cta-${stamp}@example.com`,
      name: "Ann CTA",
    });

    await openHome(page);
    const card = page.getByRole("region", { name: ACTIVE_TITLE });
    await expect(card).toBeVisible();
    await card.getByRole("link", { name: "Open Connections" }).click();

    await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: ACTIVE_TITLE })).toHaveCount(0);
    await expect(page.getByTestId("feature-announcement-ack")).toHaveAttribute(
      "data-result",
      "saved",
    );

    await openHome(page);
    await expect(page.getByRole("region", { name: ACTIVE_TITLE })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("Feature Announcement close persists acknowledgment across reloads", async ({
  browser,
  baseURL,
}, testInfo) => {
  const resolvedBase = typeof baseURL === "string" && baseURL ? baseURL : "http://127.0.0.1:5173";
  const stamp = `${Date.now()}-${testInfo.project.name}-dismiss`;
  const context = await createIsolatedBrowserContext(browser);
  const page = await context.newPage();
  try {
    await establishAnnouncementEligibleSession(page, {
      baseURL: resolvedBase,
      email: `e2e+ann-dismiss-${stamp}@example.com`,
      name: "Ann Dismiss",
    });

    await openHome(page);
    const card = page.getByRole("region", { name: ACTIVE_TITLE });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Close" }).click();
    await expect(card).toHaveCount(0);
    // Wait for the Convex mutation to settle (not optimistic localStore).
    await expect(page.getByTestId("feature-announcement-ack")).toHaveAttribute(
      "data-result",
      "saved",
    );

    await page.reload();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: ACTIVE_TITLE })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
