import type { Page } from "@playwright/test";
import { expect, inlineCreateFormCategory, test } from "./fixtures.js";

/**
 * TRUE-E2E (ADR 0019 / issue #298): Home → ordinary Global Add → create →
 * Transaction Detail → Back to the exact Home origin. Runs in the existing
 * desktop and mobile Playwright projects. Also asserts the progressive
 * reveal's focus contract and a 390 px layout (no horizontal overflow).
 */

async function openHome(page: Page) {
  await page.goto("/?currency=USD&range=3");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
}

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
  const circleSelect = page.getByLabel("Circle", { exact: true });
  await expect(circleSelect).toBeVisible();
  const firstCircleValue = await circleSelect.locator("option").nth(1).getAttribute("value");
  expect(firstCircleValue).toBeTruthy();
  await circleSelect.selectOption(firstCircleValue ?? "");

  const form = page.getByRole("form", { name: /add expense/i });
  await expect(form).toBeVisible();
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
  await form.getByRole("button", { name: "Add expense" }).click();

  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  expect(page.url()).toContain("/transactions/");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/?currency=USD&range=3");

  await page.getByRole("link", { name: "‹ Back" }).click();
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(homePathAndSearch);
});
