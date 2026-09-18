import type { Page } from "@playwright/test";
import {
  clickCircleChromeTab,
  expect,
  inlineCreateFormCategory,
  openPersonalCircleFromHome,
  saveButton,
  selectGlobalAddCircle,
  test,
  waitForTransactionsLedgerReady,
} from "./fixtures.js";

/**
 * #398 TRUE-E2E: monetary amounts never overflow their containers at the mobile
 * budget (390px). Fills the ledger with the max representable amount
 * ($999,999,999.99, ADR 0009 MAX_AMOUNT_MINOR) — the exact reproduction from the
 * issue screenshot — then asserts every amount-bearing surface stays inside the
 * viewport: Home totals, Circle Dashboard, Monthly Ledger, recent rows, and
 * contribution links. Document scrollWidth is the WebKit regression gate (sr-only
 * chart table must not widen the page).
 */

const MAX_AMOUNT = "999999999.99";
const FORMATTED_MAX = "$999,999,999.99";
const MOBILE_BUDGET = { width: 390, height: 844 } as const;

async function assertNoMoneyOverflow(page: Page) {
  // Wait for web fonts before measuring — AnimatedMoney may still be on exact
  // NumberFlow until document.fonts settles, then compact. Asserting mid-swap
  // can false-pass (clipped exact) or false-fail on layout.
  await page.evaluate(async () => {
    const fonts = document.fonts;
    if (!fonts) return;
    await fonts.ready;
    // ready can be replaced while status is still "loading" (WebKit quirk).
    if (fonts.status === "loading") await fonts.ready;
  });
  return page.evaluate<string[]>(() => {
    const bad: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) {
      bad.push(`document ${root.scrollWidth} > ${root.clientWidth}`);
    }
    for (const el of document.querySelectorAll<HTMLElement>(
      "[data-money], [data-compact-money], [data-testid='circle-mobile-bottom-nav']",
    )) {
      if (el.closest(".sr-only")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1) continue;
      if (r.right > root.clientWidth + 1 || r.left < -1) {
        bad.push(
          `${el.tagName}.${String(el.className).slice(0, 40)} outside viewport (${Math.round(r.left)}..${Math.round(r.right)})`,
        );
      }
    }
    return bad;
  });
}

test("max amounts stay inside every money surface at the 390px mobile budget", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(MOBILE_BUDGET);

  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const title = `E2E Max ${stamp}`;
  const incomeTitle = `E2E Max income ${stamp}`;

  await openPersonalCircleFromHome(page);

  await test.step("record a max-amount expense and income", async () => {
    await clickCircleChromeTab(page, "Transactions");
    await page.getByRole("link", { name: "Add expense" }).click();
    const form = page.getByRole("form", { name: /add expense/i });
    await form.getByLabel("Title").fill(title);
    await form.getByLabel(/Amount/).fill(MAX_AMOUNT);
    await inlineCreateFormCategory(page, form, `OV spend ${stamp}`.slice(0, 40));
    await saveButton(form).click();
    await expect(page.getByRole("listitem").filter({ hasText: title }).first()).toBeVisible();

    await page.getByRole("link", { name: "Add income" }).click();
    const incomeForm = page.getByRole("form", { name: /add income/i });
    await incomeForm.getByLabel("Title").fill(incomeTitle);
    await incomeForm.getByLabel(/Amount/).fill(MAX_AMOUNT);
    await inlineCreateFormCategory(page, incomeForm, `OV cat ${stamp}`.slice(0, 40));
    await saveButton(incomeForm).click();
    await expect(page.getByRole("listitem").filter({ hasText: incomeTitle }).first()).toBeVisible();
  });

  await test.step("Circle Dashboard: totals grid + recent activity", async () => {
    await clickCircleChromeTab(page, "Dashboard");
    await expect(page.getByRole("region", { name: /recent activity/i })).toBeVisible();
    expect(await assertNoMoneyOverflow(page)).toEqual([]);
    await expect(
      page.getByRole("listitem").filter({ hasText: title }).getByText(FORMATTED_MAX),
    ).toBeVisible();
  });

  await test.step("Monthly Ledger: cards + rows", async () => {
    await clickCircleChromeTab(page, "Transactions");
    await waitForTransactionsLedgerReady(page);
    expect(await assertNoMoneyOverflow(page)).toEqual([]);
    await expect(
      page.getByRole("listitem").filter({ hasText: title }).getByText(FORMATTED_MAX),
    ).toBeVisible();
  });

  await test.step("Home: totals, contributions, recent transactions", async () => {
    await page.goto("/");
    await expect(page.getByRole("region", { name: "Cash flow" })).toBeVisible();
    expect(await assertNoMoneyOverflow(page)).toEqual([]);
    await expect(
      page.getByRole("region", { name: "Per-Circle contribution" }).getByRole("link").first(),
    ).toContainText(FORMATTED_MAX);
    await expect(
      page.getByRole("region", { name: "Recent transactions" }).getByText(FORMATTED_MAX).first(),
    ).toBeVisible();
  });

  await test.step("Global Add at 390px: max-amount input echo", async () => {
    await page.goto("/transactions/new?returnTo=%2F");
    await expect(page.getByRole("heading", { name: "Add transaction" })).toBeVisible();
    await selectGlobalAddCircle(page);
    const form = page.getByRole("form", { name: /add expense/i });
    await form.getByLabel("Title").fill(`E2E OV input ${stamp}`);
    await form.getByLabel(/Amount/).fill(MAX_AMOUNT);
    await expect(form.getByLabel(/Amount/)).toHaveValue(MAX_AMOUNT);
    expect(await assertNoMoneyOverflow(page)).toEqual([]);
  });
});
