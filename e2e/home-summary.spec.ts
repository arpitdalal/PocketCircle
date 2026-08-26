import type { Browser, Page } from "@playwright/test";
import { addMonths, currentMonth } from "../packages/domain/src/date.ts";
import {
  clickCircleChromeTab,
  createIsolatedBrowserContext,
  createRegularCircleAndFinishSetup,
  establishE2ESession,
  expect,
  expectHeadlineMoney,
  finishCircleSetup,
  headlineMoney,
  homeCircleCard,
  inlineCreateFormCategory,
  inviteMemberByEmail,
  pickFormCategory,
  returnFromTransactionDetail,
  selectGlobalAddCircle,
  test,
  toggleHomeScopeCircle,
} from "./fixtures.js";

async function openHome(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Cash flow" })).toBeVisible();
}

function cashFlowTotals(page: Page) {
  return page
    .getByRole("region", { name: "Cash flow" })
    .getByRole("group", { name: "Cash flow totals" });
}

function cashFlowTotal(page: Page, label: "Income" | "Expenses" | "Net cash flow") {
  return cashFlowTotals(page).getByRole("group", { name: label });
}

function contributionLink(page: Page, name: string | RegExp) {
  return page.getByRole("region", { name: "Per-Circle contribution" }).getByRole("link", { name });
}

async function openIsolatedHomeSession(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
  name: string,
) {
  const resolvedBase = typeof baseURL === "string" && baseURL ? baseURL : "http://127.0.0.1:5173";
  const context = await createIsolatedBrowserContext(browser);
  const page = await context.newPage();
  await establishE2ESession(page, { baseURL: resolvedBase, email, name });
  return { context, page, resolvedBase };
}

function lastMonthMidpoint() {
  return `${addMonths(currentMonth(new Date()), -1)}-15`;
}

async function pickChecklistCircle(page: Page, circleName: string) {
  const dialog = page.getByRole("dialog", { name: /Choose a Circle/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: new RegExp(circleName) }).click();
}

async function addExpenseOnCurrentForm(
  page: Page,
  opts: { title: string; amount: string; category?: string; paidBy?: string; date?: string },
) {
  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(opts.title);
  await form.getByLabel(/Amount/).fill(opts.amount);
  if (opts.date) {
    await form.getByLabel("Date").fill(opts.date);
  }
  if (opts.category) {
    await pickFormCategory(page, form, opts.category);
  } else {
    await inlineCreateFormCategory(page, form, `${opts.title} cat`);
  }
  if (opts.paidBy) {
    await form.getByLabel("Paid by").selectOption({ label: opts.paidBy });
  }
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
}

/**
 * GH-273 TRUE-E2E: one isolated multi-User flow covering Home Summary cash flow,
 * Paid-By attribution, Circle inclusion, Currency isolation, range, drilldowns,
 * and the Home Activation Checklist picker.
 */
test("Home Summary reports attributed cash flow by Currency and keeps Circle navigation", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const stamp = `${Date.now()}`;
  const ownerEmail = `e2e+home-owner-${stamp}@example.com`;
  const memberEmail = `e2e+home-member-${stamp}@example.com`;
  const sharedName = `Home Shared ${stamp}`;
  const euroName = `Home Euro ${stamp}`;
  const categoryName = `HomeCat ${stamp}`.slice(0, 40);
  const { context, page, resolvedBase } = await openIsolatedHomeSession(
    browser,
    baseURL,
    ownerEmail,
    "Ada E2E",
  );

  try {
    await openHome(page);
    const checklist = page.getByRole("region", { name: "Get started" });
    await expect(checklist).toBeVisible();
    await expect(checklist.getByText("0 of 4 complete")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cash flow" })).toBeVisible();

    await checklist
      .getByRole("listitem")
      .filter({ hasText: "Create a shared Circle" })
      .getByRole("link", { name: "Create circle" })
      .click();
    await page.getByLabel("Name").fill(sharedName);
    await page.getByRole("button", { name: "Create circle" }).click();
    await finishCircleSetup(page);

    await openHome(page);
    await expect(checklist.getByText("1 of 4 complete")).toBeVisible();
    await expect(checklist.getByRole("button", { name: "New category" })).toBeVisible();

    await checklist.getByRole("button", { name: "New category" }).click();
    await pickChecklistCircle(page, sharedName);
    const categoryForm = page.getByRole("form", { name: "New category" });
    await categoryForm.getByLabel(/New expense category/).fill(categoryName);
    await categoryForm.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Get started" }).getByText("2 of 4 complete"),
    ).toBeVisible();

    await page
      .getByRole("region", { name: "Get started" })
      .getByRole("link", { name: "Add expense" })
      .click();
    await expect(page.getByRole("heading", { name: "Add transaction" })).toBeVisible();
    await selectGlobalAddCircle(page, sharedName);
    await addExpenseOnCurrentForm(page, {
      title: `Shared spend ${stamp}`,
      amount: "25.00",
      category: categoryName,
    });
    await returnFromTransactionDetail(page);
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();

    await homeCircleCard(page, /Ada's Circle/).click();
    await clickCircleChromeTab(page, "Transactions");
    await page.getByRole("link", { name: "Add income" }).click();
    const incomeForm = page.getByRole("form", { name: /add income/i });
    await incomeForm.getByLabel("Title").fill(`Personal pay ${stamp}`);
    await incomeForm.getByLabel(/Amount/).fill("100.00");
    await inlineCreateFormCategory(page, incomeForm, `Pay ${stamp}`.slice(0, 40));
    await incomeForm.getByRole("button", { name: "Save" }).click();
    await expect(incomeForm).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();

    await page.getByRole("link", { name: "Add expense" }).click();
    await addExpenseOnCurrentForm(page, {
      title: `Last month ${stamp}`,
      amount: "7.00",
      date: lastMonthMidpoint(),
    });

    await openHome(page);
    const cashFlow = page.getByRole("region", { name: "Cash flow" });
    await expectHeadlineMoney(cashFlowTotal(page, "Income"), "$100.00");
    await expectHeadlineMoney(cashFlowTotal(page, "Expenses"), "$25.00");
    await expectHeadlineMoney(cashFlowTotal(page, "Net cash flow"), "$75.00");
    await expect(cashFlow.getByRole("link", { name: /Shared spend/ })).toBeVisible();
    await expect(contributionLink(page, new RegExp(sharedName))).toBeVisible();
    await expect(homeCircleCard(page, new RegExp(sharedName))).toBeVisible();

    const token = await (async () => {
      await homeCircleCard(page, new RegExp(sharedName)).click();
      return inviteMemberByEmail(page, memberEmail);
    })();

    const memberSession = await openIsolatedHomeSession(
      browser,
      resolvedBase,
      memberEmail,
      "Ivy Invitee",
    );
    try {
      await memberSession.page.goto(`/invite/${token}`);
      await memberSession.page.getByRole("button", { name: "Accept invitation" }).click();
      await memberSession.page.waitForURL(/\/circles\/[^/]+-[^/]+(?:\/|$)/);

      await clickCircleChromeTab(memberSession.page, "Transactions");
      await memberSession.page.getByRole("link", { name: "Add expense" }).click();
      await addExpenseOnCurrentForm(memberSession.page, {
        title: `Ivy for Ada ${stamp}`,
        amount: "10.00",
        category: "Groceries",
        paidBy: "Ada E2E",
      });
    } finally {
      await memberSession.context.close();
    }

    await openHome(page);
    await expectHeadlineMoney(cashFlowTotal(page, "Expenses"), "$35.00");
    await expectHeadlineMoney(cashFlowTotal(page, "Net cash flow"), "$65.00");

    await homeCircleCard(page, new RegExp(sharedName)).click();
    await clickCircleChromeTab(page, "Transactions");
    await page.getByRole("link", { name: "Add expense" }).click();
    await addExpenseOnCurrentForm(page, {
      title: `Ada for Ivy ${stamp}`,
      amount: "50.00",
      category: categoryName,
      paidBy: "Ivy Invitee",
    });

    await openHome(page);
    await expectHeadlineMoney(cashFlowTotal(page, "Expenses"), "$35.00");
    await expect(headlineMoney(cashFlowTotals(page), "$50.00")).toHaveCount(0);

    await toggleHomeScopeCircle(page, new RegExp(sharedName));
    await expect(page.getByText(/USD · 1 of 2 circles/)).toBeVisible();
    await expectHeadlineMoney(cashFlowTotal(page, "Income"), "$100.00");
    await expectHeadlineMoney(cashFlowTotal(page, "Expenses"), "$0.00");
    await expectHeadlineMoney(cashFlowTotal(page, "Net cash flow"), "$100.00");
    await expect(contributionLink(page, new RegExp(sharedName))).toHaveCount(0);
    await expect(homeCircleCard(page, new RegExp(sharedName))).toBeVisible();

    await page.reload();
    await expect(page.getByText(/USD · 1 of 2 circles/)).toBeVisible({ timeout: 15_000 });
    await expectHeadlineMoney(cashFlowTotal(page, "Expenses"), "$0.00");
    await expect(contributionLink(page, new RegExp(sharedName))).toHaveCount(0);
    await expect(homeCircleCard(page, new RegExp(sharedName))).toBeVisible();

    const signedInAgain = await openIsolatedHomeSession(
      browser,
      resolvedBase,
      ownerEmail,
      "Ada E2E",
    );
    try {
      await openHome(signedInAgain.page);
      await expect(signedInAgain.page.getByText(/USD · 1 of 2 circles/)).toBeVisible();
      await expectHeadlineMoney(cashFlowTotal(signedInAgain.page, "Expenses"), "$0.00");
      await expect(contributionLink(signedInAgain.page, new RegExp(sharedName))).toHaveCount(0);
      await expect(homeCircleCard(signedInAgain.page, new RegExp(sharedName))).toBeVisible();
    } finally {
      await signedInAgain.context.close();
    }

    await toggleHomeScopeCircle(page, new RegExp(sharedName));
    await expect(page.getByText(/USD · 2 of 2 circles/)).toBeVisible();
    await expectHeadlineMoney(cashFlowTotal(page, "Expenses"), "$35.00");

    await createRegularCircleAndFinishSetup(page, { name: euroName, currency: "EUR" });
    await clickCircleChromeTab(page, "Transactions");
    await page.getByRole("link", { name: "Add expense" }).click();
    await addExpenseOnCurrentForm(page, {
      title: `Euro spend ${stamp}`,
      amount: "80.00",
      category: "Groceries",
    });

    await openHome(page);
    const currency = page.getByRole("group", { name: "Currency" });
    await expect(currency.getByRole("button", { name: "USD", pressed: true })).toBeVisible();
    await expectHeadlineMoney(cashFlowTotal(page, "Expenses"), "$35.00");
    await currency.getByRole("button", { name: "EUR", exact: true }).click();
    await expect(currency.getByRole("button", { name: "EUR", pressed: true })).toBeVisible();
    await expectHeadlineMoney(cashFlowTotal(page, "Expenses"), "€80.00");
    await expect(headlineMoney(cashFlowTotals(page), "$35.00")).toHaveCount(0);
    await currency.getByRole("button", { name: "USD", exact: true }).click();
    await expectHeadlineMoney(cashFlowTotal(page, "Expenses"), "$35.00");

    const trendRows = page.getByRole("region", { name: "Cash flow" }).locator("table tbody tr");
    await expect(trendRows).toHaveCount(1);
    await page.getByRole("button", { name: "3 mo" }).click();
    await expect(trendRows).toHaveCount(3);
    await expectHeadlineMoney(cashFlowTotal(page, "Expenses"), "$42.00");

    const homeUrl = new URL(page.url());
    expect(homeUrl.searchParams.get("currency")).toBe("USD");
    expect(homeUrl.searchParams.get("range")).toBe("3");

    await page
      .getByRole("region", { name: "Recent transactions" })
      .getByRole("link", { name: /Ivy for Ada/ })
      .click();
    await expect(page.getByRole("heading", { name: `Ivy for Ada ${stamp}` })).toBeVisible();
    await page.getByRole("link", { name: "‹ Back" }).click();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("currency")).toBe("USD");
    expect(new URL(page.url()).searchParams.get("range")).toBe("3");

    await contributionLink(page, new RegExp(sharedName)).click();
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("range")).toBe("3");
  } finally {
    await context.close();
  }
});
