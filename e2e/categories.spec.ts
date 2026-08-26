import {
  archiveWithDoubleCheck,
  clickCircleChromeTab,
  createCategoryViaForm,
  createRegularCircleAndFinishSetup,
  expect,
  openPersonalCircleFromHome,
  saveAndNewButton,
  saveButton,
  test,
} from "./fixtures.js";

/**
 * TRUE-E2E (ADR 0019): create a Category through the real frontend → Convex
 * `createCategory` mutation → DB → reactive `listCategories` render path, with
 * the injected backend session (no OAuth). Exercises CAT-1's critical flow end
 * to end against the self-hosted backend.
 *
 * Categories may be created in any Circle the User belongs to, including the
 * Personal Circle (PRD story 48), which every bootstrapped User already has — so
 * this needs no Circle-creation UI (CS-0) to run.
 *
 * The name is unique per run because the self-hosted backend persists across
 * specs and uniqueness is enforced per (Circle, type) including archived names.
 */
test("a member creates a category and sees it in the live list", async ({ page }) => {
  const name = `E2E Groceries ${Date.now()}`;

  await openPersonalCircleFromHome(page);

  await clickCircleChromeTab(page, "Categories");
  await expect(page.getByRole("heading", { name: "Categories" })).toBeVisible();

  // The dedicated new-Category page (issue #96): CTA → form → back on the list. Pick a
  // non-default palette color so the choice is exercised, not the default.
  await createCategoryViaForm(page, { name, color: "Teal" });

  // The reactive list shows the new Category once back on the list, no reload.
  await expect(page.getByRole("listitem").filter({ hasText: name })).toBeVisible();
});

test("Save & new then Save creates two independent Categories on the list", async ({ page }) => {
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const first = `E2E SN First ${nonce}`;
  const second = `E2E SN Second ${nonce}`;

  await openPersonalCircleFromHome(page);
  await clickCircleChromeTab(page, "Categories");

  await page.getByRole("link", { name: "New category" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const form = page.getByRole("form", { name: "New category" });
  await form.getByLabel(/New expense category/).fill(first);
  await saveAndNewButton(form).click();

  await expect(page.getByText("Category added. Ready for another.")).toBeVisible();
  await expect(form.getByLabel(/New expense category/)).toHaveValue("");
  await expect(form.getByLabel(/New expense category/)).toBeFocused();
  expect(page.url()).toContain("/categories/new");
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  await form.getByLabel(/New expense category/).fill(second);
  await saveButton(form).click();
  await page.waitForURL(/\/categories(?:\?|$)/);

  await expect(page.getByRole("listitem").filter({ hasText: first })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: second })).toBeVisible();
});

/**
 * Issue #138: the list shows all types together by default (no tab switch), the
 * in-form Type toggle picks the type, and each row is tagged with a type pill. One
 * spec covers the whole new surface against the real create → reactive list path.
 */
test("lists income and expense together under the default All view, each type-tagged", async ({
  page,
}) => {
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const expenseName = `E2E All Expense ${nonce}`;
  const incomeName = `E2E All Income ${nonce}`;

  await openPersonalCircleFromHome(page);
  await clickCircleChromeTab(page, "Categories");

  // The toggle, not a list tab, picks the type — `createCategoryViaForm` flips it.
  await createCategoryViaForm(page, { name: expenseName });
  await createCategoryViaForm(page, { name: incomeName, type: "income" });

  // Default All view: both types are visible WITHOUT switching the type filter.
  const expenseRow = page.getByRole("listitem").filter({ hasText: expenseName });
  const incomeRow = page.getByRole("listitem").filter({ hasText: incomeName });
  await expect(expenseRow).toBeVisible();
  await expect(incomeRow).toBeVisible();
  // Each row carries its type pill so the interleaved view reads unambiguously.
  await expect(expenseRow.getByText("expense", { exact: true })).toBeVisible();
  await expect(incomeRow.getByText("income", { exact: true })).toBeVisible();

  // The Income type filter narrows to income only.
  await page.getByRole("group", { name: "Type" }).getByRole("button", { name: "Income" }).click();
  await expect(incomeRow).toBeVisible();
  await expect(expenseRow).toHaveCount(0);
});

test("the server rejects a duplicate name inline", async ({ page }) => {
  const name = `E2E Dupe ${Date.now()}`;

  await openPersonalCircleFromHome(page);
  await clickCircleChromeTab(page, "Categories");

  await createCategoryViaForm(page, { name });
  await expect(page.getByRole("listitem").filter({ hasText: name })).toBeVisible();

  // A case-only duplicate is rejected by the server and surfaced inline on the create page,
  // which stays put (the one user-fixable error) rather than navigating back to the list.
  await page.getByRole("link", { name: "New category" }).click();
  await page.getByLabel(/New expense category/).fill(name.toUpperCase());
  await saveButton(page).click();
  await expect(page.getByRole("alert")).toHaveText(/already exists/i);
});

/**
 * CAT-2 critical flow: edit → history → archive → restore through the real
 * frontend → Convex mutations → reactive `listCategories` / `listCategoryHistory`
 * render paths. The injected User owns the Personal Circle, so they are both the
 * Category creator (field edits) and the Owner (moderation) — the permission
 * matrix itself lives in the convex-test suite.
 */
test("a member edits, archives, and restores a category and sees its history", async ({ page }) => {
  const name = `E2E Lifecycle ${Date.now()}`;
  const renamed = `${name} v2`;

  await openPersonalCircleFromHome(page);
  await clickCircleChromeTab(page, "Categories");

  await createCategoryViaForm(page, { name });
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toBeVisible();

  // Rename through the inline edit form; the reactive list updates in place.
  await page.getByRole("button", { name: `Edit ${name}` }).click();
  const editForm = page.getByRole("form", { name: `Edit ${name}` });
  await editForm.getByLabel("Name").fill(renamed);
  await saveButton(editForm).click();
  await expect(page.getByRole("listitem").filter({ hasText: renamed })).toBeVisible();

  // The history panel shows the edit over the create, newest first.
  const historyButton = page.getByRole("button", { name: `History of ${renamed}` });
  await historyButton.click();
  const history = page.getByRole("region", { name: `${renamed} history` });
  await expect(history.getByText("edited")).toBeVisible();
  await expect(history.getByText("created")).toBeVisible();
  // Collapse before archiving so later list assertions see only category rows
  // (the panel renders its own list items inside the row).
  await historyButton.click();
  await expect(history).toHaveCount(0);

  // Archive: under the default `all` scope the row stays, badge flipped in place
  // (CAT-4 — archived rows are distinguished, not hidden).
  await archiveWithDoubleCheck(page, renamed);
  const archivedRow = page.getByRole("listitem").filter({ hasText: renamed });
  await expect(archivedRow.getByText("Archived")).toBeVisible();

  // Narrowed to active, the archived row is gone; restore from the archived scope.
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: renamed })).toHaveCount(0);
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await page.getByRole("button", { name: `Restore ${renamed}` }).click();
  await expect(page.getByRole("listitem").filter({ hasText: renamed })).toHaveCount(0);

  // Back on the active scope the restored category is present again.
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: renamed })).toBeVisible();
});

/**
 * CAT-4 critical flow: the Category Filter end to end — debounced name search
 * narrowing the live `filterCategories` page, the tri-state lifecycle scope,
 * URL-owned state surviving a reload (ADR 0016), source pagination via Load
 * more, and an archive reactively leaving the active-scoped list.
 *
 * Names carry a per-run nonce: the shared backend accretes Categories across
 * specs and runs, so every assertion filters by this run's rows.
 *
 * The 27 seeded rows live in a DEDICATED Circle, not the shared Personal
 * Circle: every Category seeded there lands as a chip in every other spec's
 * Transaction-form picker (the form collects the whole selectable set), and
 * that load is exactly what makes the reactive form tests flake.
 */
test("the category filter searches, scopes by status, reloads from the URL, and paginates", async ({
  page,
}) => {
  test.slow(); // seeds past one 25-row page through the real create form

  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const matchName = (i: number) => `E2E Filter Match ${i} ${nonce}`;
  const otherName = `E2E Filter Other ${nonce}`;

  // An isolated Circle keeps the seeding out of the Personal Circle's pickers.
  await createRegularCircleAndFinishSetup(page, { name: `E2E Filter Circle ${nonce}` });
  await clickCircleChromeTab(page, "Categories");

  // Seed 26 matching + 1 non-matching expense Categories (page size is 25). Each create
  // round-trips through the dedicated new-Category page and back to the list (issue #96).
  for (let i = 0; i < 26; i++) {
    await createCategoryViaForm(page, { name: matchName(i) });
  }
  await createCategoryViaForm(page, { name: otherName });
  await expect(page.getByRole("listitem").filter({ hasText: otherName })).toBeVisible();

  // Search narrows the live list (substring, case-insensitive) and lands in the URL.
  const search = page.getByLabel("Search categories by name");
  await search.fill(`filter match 25 ${nonce}`);
  await expect(page.getByRole("listitem").filter({ hasText: matchName(25) })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: otherName })).toHaveCount(0);
  await expect(page).toHaveURL(/q=filter\+match\+25/);

  // Reload: the filtered view reproduces from the URL alone.
  await page.reload();
  await expect(page.getByRole("listitem").filter({ hasText: matchName(25) })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: otherName })).toHaveCount(0);

  // Widen to this run's full set by the nonce (27 rows — two source pages).
  // Searching the nonce, not a shared term, keeps the parallel desktop/mobile
  // projects (same backend, same Personal Circle) out of each other's pages.
  await search.fill(nonce);
  // Keep the sentinel below the 200px rootMargin prefetch zone so we do not assert
  // visibility on an element that may already have auto-fired (short rows / smaller page size).
  await page.evaluate(() => window.scrollTo(0, 0));
  const matchRows = page.getByRole("listitem").filter({ hasText: nonce });
  const sentinel = page.getByTestId("categories-infinite-scroll-sentinel");
  const page2Row = matchRows.filter({ hasText: `Match 0 ${nonce}` });
  await expect(sentinel.or(page2Row)).toBeVisible({ timeout: 15_000 });

  if (await sentinel.isVisible()) {
    const firstPageCount = await matchRows.count();
    expect(firstPageCount).toBeLessThanOrEqual(25); // the first page is bounded
    await sentinel.scrollIntoViewIfNeeded();
  }
  await expect(page2Row).toBeVisible({ timeout: 15_000 });

  // Archive one row, then scope to active: it reactively leaves the list.
  await archiveWithDoubleCheck(page, matchName(25));
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: matchName(25) })
      .getByText("Archived"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: matchName(25) })).toHaveCount(0);

  // The archived scope shows only it (of this run's rows still matching).
  await page.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: matchName(25) })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: `Match 24 ${nonce}` })).toHaveCount(0);
});
