import type { Page } from "@playwright/test";
import {
  expect,
  inlineCreateFormCategory,
  openHome,
  openPersonalCircleFromHome,
  pickFormCategory,
  returnFromTransactionDetail,
  selectGlobalAddCircle,
  test,
} from "./fixtures.js";

/**
 * TRUE-E2E (ADR 0019 / issue #298 / parent #296 §19–21): the critical Global Add
 * navigation paths. Exceptional-state permutations (confirmations, reactive
 * invalidation, Currency races) stay in the real-Router suite — do not multiply
 * slow Playwright cases for them.
 */

async function assertNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test("Home Global Add records a Transaction and Back restores the Home origin", async ({
  page,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `GA Cat ${stamp}`.slice(0, 40);
  const title = `GA Lunch ${stamp}`;

  await openHome(page);
  const homePathAndSearch = new URL(page.url()).pathname + new URL(page.url()).search;

  await page.getByRole("link", { name: "Add transaction" }).click();
  await expect(page.getByRole("heading", { name: "Add transaction" })).toBeVisible();
  await expect(page.getByText("Choose a Circle to continue")).toBeVisible();

  // 390 px is the mobile layout budget called out by the ticket; set it for
  // the progressive page so both Playwright projects assert the same width.
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);

  // Destination: the worker's Personal Circle (always eligible after bootstrap).
  await selectGlobalAddCircle(page);

  const form = page.getByRole("form", { name: /add expense/i });
  const titleField = form.getByLabel("Title");
  await expect(titleField).toBeFocused();
  // Step 2 should be scrolled into the viewport after Circle selection.
  await expect
    .poll(async () => {
      return titleField.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top >= 0 && rect.top < window.innerHeight;
      });
    })
    .toBe(true);
  await assertNoHorizontalOverflow(page);

  await titleField.fill(title);
  await form.getByLabel(/Amount/).fill("12.50");
  await inlineCreateFormCategory(page, form, categoryName);
  await form.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  expect(page.url()).toContain("/transactions/");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/?currency=USD&range=3");

  await returnFromTransactionDetail(page);
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(homePathAndSearch);
});

test("Global Add Save & new then Save keeps both Transactions and the Detail return chain", async ({
  page,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `GA SN Cat ${stamp}`.slice(0, 40);
  const firstTitle = `GA First ${stamp}`;
  const secondTitle = `GA Second ${stamp}`;

  await openHome(page);
  const homePathAndSearch = new URL(page.url()).pathname + new URL(page.url()).search;

  await page.getByRole("link", { name: "Add transaction" }).click();
  await selectGlobalAddCircle(page);

  await page.setViewportSize({ width: 390, height: 844 });
  const form = page.getByRole("form", { name: /add expense/i });
  await assertNoHorizontalOverflow(page);

  await form.getByLabel("Title").fill(firstTitle);
  await form.getByLabel(/Amount/).fill("5.00");
  await inlineCreateFormCategory(page, form, categoryName);
  await form.getByRole("button", { name: "Save & new" }).click();

  await expect(page.getByText("Transaction added. Ready for another.")).toBeVisible();
  await expect(form.getByLabel("Title")).toHaveValue("");
  await expect(form.getByLabel("Title")).toBeFocused();
  expect(page.url()).toContain("/transactions/new");
  await assertNoHorizontalOverflow(page);

  await form.getByLabel("Title").fill(secondTitle);
  await form.getByLabel(/Amount/).fill("7.00");
  await pickFormCategory(page, form, categoryName);
  await form.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("heading", { level: 2, name: secondTitle })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/?currency=USD&range=3");

  await returnFromTransactionDetail(page);
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(homePathAndSearch);

  // Both independent Transactions exist on the Personal Circle ledger.
  await openPersonalCircleFromHome(page);
  await expect(page.getByRole("listitem").filter({ hasText: firstTitle })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: secondTitle })).toBeVisible();
});

test("Cancel from Global Add returns to the exact Home origin", async ({ page }) => {
  await openHome(page);
  const homePathAndSearch = new URL(page.url()).pathname + new URL(page.url()).search;

  await page.getByRole("link", { name: "Add transaction" }).click();
  await expect(page.getByRole("heading", { name: "Add transaction" })).toBeVisible();
  await selectGlobalAddCircle(page);

  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill("Will cancel");
  await form.getByRole("button", { name: "Cancel" }).click();

  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(homePathAndSearch);
});
