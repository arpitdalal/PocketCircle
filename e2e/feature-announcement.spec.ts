import {
  createIsolatedBrowserContext,
  establishE2ESession,
  expect,
  inlineCreateFormCategory,
  openHome,
  returnFromTransactionDetail,
  selectGlobalAddCircle,
  test,
} from "./fixtures.js";

/**
 * TRUE-E2E Feature Announcement (#282). Uses throwaway Users (not the worker
 * storageState session) so acknowledgment from one scenario cannot hide the
 * card for another. Backdates `createdAt` so eligibility survives release-prep
 * replacement of the provisional `eligibleBefore`.
 */

/** Well before any Duplicate release cutoff — keeps E2E Users eligible. */
const ANNOUNCEMENT_ELIGIBLE_CREATED_AT = Date.parse("2020-01-01T00:00:00.000Z");

async function establishAnnouncementEligibleSession(
  page: import("@playwright/test").Page,
  opts: { baseURL: string; email: string; name: string },
) {
  await establishE2ESession(page, opts);
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

async function seedSourceTransaction(
  page: import("@playwright/test").Page,
  opts: { categoryName: string; sourceTitle: string; amount: string },
) {
  await openHome(page);
  await page.getByRole("link", { name: "Add transaction" }).click();
  await selectGlobalAddCircle(page);
  const createForm = page.getByRole("form", { name: /add expense/i });
  await createForm.getByLabel("Title").fill(opts.sourceTitle);
  await createForm.getByLabel(/Amount/).fill(opts.amount);
  await inlineCreateFormCategory(page, createForm, opts.categoryName);
  await createForm.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("heading", { level: 2, name: opts.sourceTitle })).toBeVisible();
}

test("Feature Announcement CTA reaches focused Duplicate and preserves the return chain", async ({
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

    const categoryName = `Ann Cat ${stamp}`.slice(0, 40);
    const sourceTitle = `Ann Source ${stamp}`;
    const copyTitle = `Ann Copy ${stamp}`;
    await seedSourceTransaction(page, {
      categoryName,
      sourceTitle,
      amount: "12.50",
    });

    await openHome(page);
    const card = page.getByRole("region", { name: /Duplicate a transaction/i });
    await expect(card).toBeVisible();
    await card.getByRole("link", { name: "Try Duplicate" }).click();

    await expect(page.getByRole("heading", { level: 2, name: sourceTitle })).toBeVisible();
    const duplicate = page.getByRole("link", { name: `Duplicate ${sourceTitle}` });
    await expect(duplicate).toBeFocused();

    await duplicate.click();
    await expect(page.getByRole("heading", { name: "Add transaction" })).toBeVisible();
    const dupForm = page.getByRole("form", { name: /add expense/i });
    await dupForm.getByLabel("Title").fill(copyTitle);
    await dupForm.getByRole("button", { name: "Add expense" }).click();
    await expect(page.getByRole("heading", { level: 2, name: copyTitle })).toBeVisible();

    await returnFromTransactionDetail(page);
    await expect(page.getByRole("heading", { level: 2, name: sourceTitle })).toBeVisible();
    await returnFromTransactionDetail(page);
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: /Duplicate a transaction/i })).toHaveCount(0);
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

    const categoryName = `Ann Dismiss Cat ${stamp}`.slice(0, 40);
    const sourceTitle = `Ann Dismiss Source ${stamp}`;
    await seedSourceTransaction(page, {
      categoryName,
      sourceTitle,
      amount: "9.00",
    });

    await openHome(page);
    const card = page.getByRole("region", { name: /Duplicate a transaction/i });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Close" }).click();
    await expect(card).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: /Duplicate a transaction/i })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
