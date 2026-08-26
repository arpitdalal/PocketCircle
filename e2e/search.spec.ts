import {
  clickCircleChromeTab,
  createCategoryViaForm,
  createRegularCircleAndFinishSetup,
  expect,
  openPersonalCircleFromHome,
  pickFormCategory,
  saveButton,
  test,
} from "./fixtures.js";

test("transaction search finds circle transactions across months and opens detail", async ({
  page,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `E2E S ${stamp}`;
  const title = `E2E Search ${stamp}`;
  const month = testInfo.project.name === "mobile-chromium" ? "2993-06" : "2993-05";

  await openPersonalCircleFromHome(page);

  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: categoryName });
  await expect(page.getByRole("listitem").filter({ hasText: categoryName })).toBeVisible();

  await clickCircleChromeTab(page, "Transactions");
  const monthInput = page.getByLabel("Month", { exact: true });
  await monthInput.fill(month);
  await monthInput.blur();

  await page.getByRole("link", { name: "Add expense" }).click();
  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Amount/).fill("14.00");
  await pickFormCategory(page, form, categoryName);
  await saveButton(form).click();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toBeVisible();

  await clickCircleChromeTab(page, "Search");
  await expect(page).toHaveURL(/\/search\?type=all&status=all/);
  const searchbox = page.getByRole("searchbox", { name: "Search title or note" });
  await searchbox.fill(title);
  const result = page.getByRole("listitem").filter({ hasText: title });
  await expect(result).toBeVisible();

  await page.getByRole("button", { name: /Filters/ }).click();
  const dialog = page.getByRole("dialog", { name: "Filters" });
  await dialog.getByRole("button", { name: "Expense" }).click();
  await dialog.getByLabel("From").fill(`${month}-01`);
  await dialog.getByLabel("To").fill(`${month}-28`);
  await dialog.getByLabel("Amount min").fill("14.00");
  await dialog.getByLabel("Amount max").fill("14.00");
  // Picking inside the dialog also proves the combobox popup stacks above the
  // filter sheet: Playwright's click fails if the option doesn't receive events.
  await pickFormCategory(page, dialog, categoryName);
  // Commit with Enter from a panel field instead of clicking Apply: proves native implicit
  await dialog.getByLabel("Amount max").press("Enter");
  await expect(page).toHaveURL(/type=expense/);
  await expect(page).toHaveURL(/min=14.00/);
  await expect(page).toHaveURL(/categories=/);
  await expect(result).toBeVisible();

  await result.getByRole("link", { name: `View ${title}` }).click();
  // The result detail link carries the search URL as `returnTo` so Back returns to results.
  await expect(page).toHaveURL(/\/transactions\/[^/?]+\?returnTo=.*search/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});

/**
 * RPT-7 real-backend regression: sparse text matches over more than one source
 * page used to make `filterLedgerTransactions` call `.paginate()` twice in one query
 * execution, which only the real backend rejects. Transaction search (#97) now uses
 * a single indexed or stream read per query with numbered URL pages. With a text
 * query the indexed path ranks by relevance with a creation-time tie-break, not
 * strictly by transaction date; here seeded dates ascend in lockstep with creation
 * order, so the observable order matches what date-desc stream ordering would show.
 * Seed in a dedicated Circle so the >25 rows do not bloat the shared Personal Circle's
 * form pickers.
 */
test("sparse transaction filters spanning multiple source pages do not crash", async ({
  page,
}, testInfo) => {
  test.slow();

  const projectCode = testInfo.project.name === "mobile-chromium" ? "m" : "d";
  const nonce = `${Date.now()}-${projectCode}`;
  const circleName = `E2E Sparse ${nonce}`;
  const categoryName = `E2E SpCat ${nonce}`;
  const month = projectCode === "m" ? "2994-06" : "2994-05";
  const queryText = "Sparse Needle";
  const matchingTitle = (index: number) => `E2E Sparse Needle ${index} ${nonce}`;
  // Convex full-text matches any query term, so filler rows must share no query token.
  const missTitle = (index: number) => `E2E Filler Row ${index} ${nonce}`;

  await createRegularCircleAndFinishSetup(page, { name: circleName });

  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: categoryName });
  await expect(page.getByRole("listitem").filter({ hasText: categoryName })).toBeVisible();

  await clickCircleChromeTab(page, "Transactions");
  const monthInput = page.getByLabel("Month", { exact: true });
  await monthInput.fill(month);
  await monthInput.blur();

  for (let index = 0; index < 27; index += 1) {
    const day = (index + 1).toString().padStart(2, "0");
    await page.getByRole("link", { name: "Add expense" }).click();
    const form = page.getByRole("form", { name: /add expense/i });
    await form.getByLabel("Title").fill(index % 2 === 0 ? matchingTitle(index) : missTitle(index));
    await form.getByLabel(/Amount/).fill("1.00");
    await form.getByLabel("Date").fill(`${month}-${day}`);
    await pickFormCategory(page, form, categoryName);
    await saveButton(form).click();
    await expect(form).toHaveCount(0);
  }

  await page.getByRole("button", { name: /Filters/ }).click();
  const ledgerDialog = page.getByRole("dialog", { name: "Filters" });
  const ledgerSearch = ledgerDialog.getByRole("searchbox", { name: "Search title or note" });
  await ledgerSearch.fill(queryText);
  // Enter from a panel field applies the ledger filters via the associated
  await ledgerSearch.press("Enter");
  await expect(page).toHaveURL(/q=Sparse\+Needle/);
  await expect(page.getByRole("listitem").filter({ hasText: matchingTitle(0) })).toBeVisible();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);

  await clickCircleChromeTab(page, "Search");
  await expect(page).toHaveURL(/\/search/);
  const sparseSearchbox = page.getByRole("searchbox", { name: "Search title or note" });
  await expect(sparseSearchbox).toBeVisible();
  await sparseSearchbox.fill(queryText);
  await expect(sparseSearchbox).toHaveValue(queryText);
  await sparseSearchbox.press("Enter");
  await expect(page).toHaveURL(/q=Sparse(\+|%20)Needle/);
  await expect(page.getByRole("listitem").filter({ hasText: matchingTitle(0) })).toBeVisible();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
});

test("transaction search pagination updates URL and result slice", async ({ page }, testInfo) => {
  test.slow();

  const projectCode = testInfo.project.name === "mobile-chromium" ? "m" : "d";
  const nonce = `${Date.now()}-${projectCode}`;
  const circleName = `E2E Pages ${nonce}`;
  const categoryName = `E2E PgCat ${nonce}`;
  const month = projectCode === "m" ? "2995-06" : "2995-05";
  const queryText = "Paged Needle";
  const matchingTitle = (index: number) => `E2E Paged Needle ${index} ${nonce}`;
  const rowCount = 26;

  await createRegularCircleAndFinishSetup(page, { name: circleName });

  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: categoryName });
  await expect(page.getByRole("listitem").filter({ hasText: categoryName })).toBeVisible();

  await clickCircleChromeTab(page, "Transactions");
  const monthInput = page.getByLabel("Month", { exact: true });
  await monthInput.fill(month);
  await monthInput.blur();

  for (let index = 0; index < rowCount; index += 1) {
    const day = (index + 1).toString().padStart(2, "0");
    await page.getByRole("link", { name: "Add expense" }).click();
    const form = page.getByRole("form", { name: /add expense/i });
    await form.getByLabel("Title").fill(matchingTitle(index));
    await form.getByLabel(/Amount/).fill("1.00");
    await form.getByLabel("Date").fill(`${month}-${day}`);
    await pickFormCategory(page, form, categoryName);
    await saveButton(form).click();
    await expect(form).toHaveCount(0);
  }

  await clickCircleChromeTab(page, "Search");
  await expect(page).toHaveURL(/\/search\?/);

  const searchbox = page.getByRole("searchbox", { name: "Search title or note" });
  await expect(searchbox).toBeVisible();
  await searchbox.fill(queryText);
  await expect(searchbox).toHaveValue(queryText);
  await searchbox.press("Enter");
  await expect(page).toHaveURL(/q=Paged/);

  // Indexed text search ranks by relevance with a creation-time tie-break (not pure date
  // sort). Seeded dates ascend with creation order, so newest vs oldest still land on page 1 vs 2.
  const newest = matchingTitle(rowCount - 1);
  const oldest = matchingTitle(0);
  await expect(page.getByRole("listitem").filter({ hasText: newest })).toBeVisible();
  await expect(page.getByRole("button", { name: "Page 2" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: oldest })).toHaveCount(0);

  await page.getByRole("button", { name: "Page 2" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByRole("listitem").filter({ hasText: oldest })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: newest })).toHaveCount(0);
});
