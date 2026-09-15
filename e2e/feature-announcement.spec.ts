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
    // Hero slot + highlight rows only. Deliberately NOT the <img> itself: the card
    // drops that element if the load errors, so asserting on it would make this
    // suite depend on the production CDN being reachable from CI. The image's
    // attributes are covered by the component test instead.
    await expect(card.getByTestId("feature-announcement-hero")).toBeVisible();
    await expect(card.getByRole("listitem")).toHaveCount(3);
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

test("Feature Announcement overlaps above the header on a short mobile viewport", async ({
  browser,
  baseURL,
}, testInfo) => {
  const resolvedBase = typeof baseURL === "string" && baseURL ? baseURL : "http://127.0.0.1:5173";
  const stamp = `${Date.now()}-${testInfo.project.name}-overlap`;
  const context = await createIsolatedBrowserContext(browser);
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 390, height: 480 });
    await establishAnnouncementEligibleSession(page, {
      baseURL: resolvedBase,
      email: `e2e+ann-overlap-${stamp}@example.com`,
      name: "Ann Overlap",
    });

    await openHome(page);
    const card = page.getByRole("region", { name: ACTIVE_TITLE });
    const header = page.getByRole("banner");
    await expect(card).toBeVisible();

    const [cardBox, headerBox, cardZIndex, headerZIndex] = await Promise.all([
      card.boundingBox(),
      header.boundingBox(),
      card.evaluate((element) => getComputedStyle(element).zIndex),
      header.evaluate((element) => getComputedStyle(element).zIndex),
    ]);
    if (!cardBox || !headerBox) {
      throw new Error("expected visible announcement card and header bounds");
    }

    expect(cardBox.y).toBeLessThan(headerBox.y + headerBox.height);
    expect(Number.parseInt(cardZIndex, 10)).toBeGreaterThan(Number.parseInt(headerZIndex, 10));
    await expect(card.getByRole("button", { name: "Close" })).toBeVisible();
  } finally {
    await context.close();
  }
});
