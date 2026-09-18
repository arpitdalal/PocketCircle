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
 *
 * Clip detection (bbox alone misses exact NumberFlow clipped inside
 * `overflow-hidden`): after fonts settle, re-run the same canvas measure
 * AnimatedMoney uses — if exact cannot fit, `data-compact-money` must be set
 * and that compact string must also fit. Row `MoneyAmountCell`s (wrap, no clip)
 * are checked via scrollWidth.
 */

const MAX_AMOUNT = "999999999.99";
const FORMATTED_MAX = "$999,999,999.99";
const MOBILE_BUDGET = { width: 390, height: 844 } as const;

/**
 * Browser-side money overflow contract (must stay identical for settle-wait and
 * assert). Playwright serializes this function into the page — keep it free of
 * Node closures. `mode: "settled"` → boolean; `"problems"` → diagnostic strings.
 */
function inspectMoneyOverflow(mode: "settled" | "problems") {
  const bad: string[] = [];
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth) {
    bad.push(`document ${root.scrollWidth} > ${root.clientWidth}`);
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

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

    const exact = el.getAttribute("data-money");
    if (!exact) continue;

    const style = getComputedStyle(el);
    const clips =
      style.overflow === "hidden" || style.overflowX === "hidden" || style.overflowY === "hidden";

    if (clips) {
      // Mirror AnimatedMoney: digit strips make scrollWidth noisy; canvas
      // measure of exact / compact strings is the fit gate.
      if (!ctx) continue;
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const exactWidth = ctx.measureText(exact).width;
      const needsCompact = exactWidth > el.clientWidth;
      const compact = el.getAttribute("data-compact-money");
      if (needsCompact && !compact) {
        bad.push(
          `AnimatedMoney exact clipped (measure ${Math.round(exactWidth)} > ${el.clientWidth}, no data-compact-money)`,
        );
      }
      if (compact && ctx.measureText(compact).width > el.clientWidth + 1) {
        bad.push(
          `AnimatedMoney compact clipped (measure ${Math.round(ctx.measureText(compact).width)} > ${el.clientWidth})`,
        );
      }
      continue;
    }

    // MoneyAmountCell (wrap, no clip): content wider than the box is a fail.
    if (el.scrollWidth > el.clientWidth + 1) {
      bad.push(`${el.tagName} content clipped (${el.scrollWidth} > ${el.clientWidth})`);
    }
  }

  return mode === "settled" ? bad.length === 0 : bad;
}

async function assertNoMoneyOverflow(page: Page) {
  // Fonts + settle until AnimatedMoney's compact gate matches canvas measure
  // (Home single-col can keep exact; Dashboard 3-up must compact — never require
  // compact unconditionally).
  await page.evaluate(async () => {
    const fonts = document.fonts;
    if (fonts) {
      await fonts.ready;
      if (fonts.status === "loading") await fonts.ready;
    }
  });
  await page.waitForFunction(inspectMoneyOverflow, "settled", { timeout: 5_000 });
  return page.evaluate(inspectMoneyOverflow, "problems");
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
