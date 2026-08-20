import type { Page } from "@playwright/test";
import {
  applyLedgerStatus,
  archiveWithDoubleCheck,
  clickCircleChromeTab,
  createCategoryViaForm,
  expect,
  expectHeadlineMoney,
  inlineCreateFormCategory,
  openPersonalCircleFromHome,
  pickFormCategory,
  test,
} from "./fixtures.js";

/**
 * Select a Ledger month through the native month input the way the UI commits it:
 * set the value, then blur. The Ledger commits the chosen month on BLUR (not per
 * keystroke) so a multi-keystroke year is entered whole and never pushes junk history
 * for the transient values the year segment emits while filling; `fill` alone sets the
 * value without committing it to the URL/ledger.
 */
async function selectMonth(page: Page, month: string) {
  const input = page.getByLabel("Month", { exact: true });
  await input.fill(month);
  await input.blur();
}

/**
 * TRUE-E2E (ADR 0019): record a Transaction through the real frontend → Convex
 * `createTransaction` mutation → DB → reactive `listTransactions` render path,
 * with the injected backend session (no OAuth). Exercises TXN-1's critical flow
 * end to end against the self-hosted backend.
 *
 * Transactions need ≥1 active Category of the matching type, so the test first
 * creates one (CAT-1's flow) in the Personal Circle every bootstrapped User
 * already has — no Circle-creation UI (CS-0) required. Names stay unique per run
 * and per project (`Date.now()` + project name) so rows stay distinct within a
 * worker's desktop/mobile runs.
 */
test("a member records an expense and sees it in the live list", async ({ page }, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `E2E Cat ${stamp}`;
  const title = `E2E Lunch ${stamp}`;

  await openPersonalCircleFromHome(page);

  // Seed an expense Category to attach.
  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: categoryName });
  await expect(page.getByRole("listitem").filter({ hasText: categoryName })).toBeVisible();

  // Record the expense.
  await clickCircleChromeTab(page, "Transactions");
  await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();
  await page.getByRole("link", { name: "Add expense" }).click();

  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Amount/).fill("12.50");
  await pickFormCategory(page, form, categoryName);
  await form.getByRole("button", { name: "Add expense" }).click();

  // The reactive query flips to include the new Transaction with no reload.
  const item = page.getByRole("listitem").filter({ hasText: title });
  await expect(item).toBeVisible();
  await expect(item).toContainText("12.50");
});

test("a member inline-creates a category while recording a transaction", async ({
  page,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `E2E IC ${stamp}`; // ≤ 40 chars (categoryNameMax)
  const title = `E2E InlineTxn ${stamp}`;

  await openPersonalCircleFromHome(page);

  await clickCircleChromeTab(page, "Transactions");
  await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();
  await page.getByRole("link", { name: "Add expense" }).click();

  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Amount/).fill("8.25");
  await inlineCreateFormCategory(page, form, categoryName);
  await expect(form.getByRole("button", { name: `Remove ${categoryName}` })).toBeVisible();
  await form.getByRole("button", { name: "Add expense" }).click();

  const item = page.getByRole("listitem").filter({ hasText: title });
  await expect(item).toBeVisible();
  await expect(item).toContainText("8.25");
  await expect(item).toContainText(categoryName);
});

test("the expense form blocks submit and explains a missing category", async ({
  page,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const title = `E2E NoCat ${stamp}`;

  await openPersonalCircleFromHome(page);
  await clickCircleChromeTab(page, "Transactions");
  await page.getByRole("link", { name: "Add expense" }).click();

  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Amount/).fill("5.00");

  // Submit is attemptable (no guessing why it's greyed out): pressing it with no
  // category reveals the requirement and creates nothing (the server enforces ≥1 too).
  await form.getByRole("button", { name: "Add expense" }).click();
  await expect(form.getByText("Pick at least one category")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
});

/**
 * RPT-1 true-E2E: the Monthly Ledger shows ONE selected month — the month's totals
 * (computed server-side by `getMonthlyLedger`) and that month's Transactions — with
 * month navigation, all against the real backend.
 *
 * Totals are asserted EXACTLY, which the shared current month can't support: other
 * specs may record income in the current month on this User. Each project uses its own
 * far-future month — empty at run start for that month (fresh User) and not written by
 * other specs — so the month's totals are exactly this test's one expense. Navigating the
 * create into that month relies on the form defaulting its date to the selected month.
 */
test("the monthly ledger totals a month and navigates between months", async ({
  page,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `E2E L ${stamp}`; // keep ≤ 40 chars (categoryNameMax)
  const title = `E2E Ledger ${stamp}`;
  // A private month per project so parallel desktop vs mobile ledger assertions never
  // share a month's totals when both run (sequential on one worker or concurrent across workers).
  const ledger =
    testInfo.project.name === "mobile-chromium"
      ? { month: "2999-11", label: "November 2999" }
      : { month: "2999-10", label: "October 2999" };

  await openPersonalCircleFromHome(page);

  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: categoryName });
  await expect(page.getByRole("listitem").filter({ hasText: categoryName })).toBeVisible();

  // Select the private month FIRST — it starts empty, so server totals are zero, and the
  // create form will default its date into this month.
  await clickCircleChromeTab(page, "Transactions");
  await selectMonth(page, ledger.month);
  await expect(page.getByText(`No transactions in ${ledger.label}.`)).toBeVisible();
  const totals = page.getByRole("group", { name: "Monthly totals" });
  await expectHeadlineMoney(totals, "$0.00");

  // Record an expense into the selected month.
  await page.getByRole("link", { name: "Add expense" }).click();
  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Amount/).fill("12.50");
  await pickFormCategory(page, form, categoryName);
  await form.getByRole("button", { name: "Add expense" }).click();

  // The row appears and the month's totals reflect exactly this one expense: a -$12.50 Net.
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await expectHeadlineMoney(totals, "-$12.50");

  // Jump to a far-past month no spec ever writes to: zero totals, empty list (totals are
  // per-month, not global).
  await selectMonth(page, "2000-06");
  await expect(page.getByText("No transactions in June 2000.")).toBeVisible();
  await expect(row).toHaveCount(0);
  await expectHeadlineMoney(totals, "$0.00");

  // Navigate back and the expense + its total are there again.
  await selectMonth(page, ledger.month);
  await expect(row).toBeVisible();
  await expectHeadlineMoney(totals, "-$12.50");
});

/**
 * Regression (TXN-5): typing a multi-digit year into the native month input must
 * register the WHOLE year. The input was controlled straight off the async URL state,
 * so each keystroke of a 4-digit year re-rendered with the not-yet-updated month and
 * snapped the half-typed year segment back — only the first digit or two survived. This
 * types the date digit-by-digit (NOT `fill`, which sets the value atomically and hid the
 * bug in both jsdom and Playwright) and asserts the full year lands. A private far-future
 * month per project keeps the parallel runs from colliding.
 */
test("the month input registers a whole multi-digit year typed digit-by-digit", async ({
  page,
}, testInfo) => {
  const target =
    testInfo.project.name === "mobile-chromium"
      ? { value: "2997-08", label: "August 2997" }
      : { value: "2997-07", label: "July 2997" };
  const [year, mm] = target.value.split("-");

  await openPersonalCircleFromHome(page);
  await clickCircleChromeTab(page, "Transactions");
  await expect(page).toHaveURL(/\/transactions\?month=\d{4}-\d{2}/);

  // Drive the native segments with real, separate keystrokes — the exact path that lost
  // digits before (NOT `fill`, which sets the value atomically and hid the bug). Focus
  // lands on the month segment; type MM, step to the year segment, then type the 4-digit
  // year digit-by-digit so a reset of the year buffer would surface as a dropped year.
  const input = page.getByLabel("Month", { exact: true });
  await input.focus();
  await input.pressSequentially(mm, { delay: 50 });
  await input.press("ArrowRight");
  await input.pressSequentially(year, { delay: 50 });
  await input.blur();

  await expect(page).toHaveURL(new RegExp(`month=${target.value}`));
  await expect(input).toHaveValue(target.value);
  await expect(page.getByText(`No transactions in ${target.label}.`)).toBeVisible();
});

/**
 * TXN-2 true-E2E: the Recorded By Member edits a saved Transaction through the real
 * frontend → `updateTransaction` mutation → DB → reactive list, and a Type Change
 * (Expense→Income) confirms, clears the old Category, requires re-picking from the
 * new type, and flips the row to income end to end.
 */
test("the recorder edits a transaction and changes its type", async ({ page }, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const expenseCat = `E2E Exp ${stamp}`;
  const incomeCat = `E2E Inc ${stamp}`;
  const title = `E2E Edit ${stamp}`;
  const editedTitle = `${title} edited`;
  // A private far-future month per project keeps the parallel runs from colliding
  // on the shared Personal Circle's current-month Ledger — otherwise concurrent
  // tests crowd the month and pagination can push the edited row off the page.
  const month = testInfo.project.name === "mobile-chromium" ? "2995-06" : "2995-05";

  await openPersonalCircleFromHome(page);

  // Seed one Category of each type to work with.
  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: expenseCat });
  await expect(page.getByRole("listitem").filter({ hasText: expenseCat })).toBeVisible();
  // The income tab in the Categories surface (CAT-1) — the helper deep-links the type.
  await createCategoryViaForm(page, { name: incomeCat, type: "income" });
  await expect(page.getByRole("listitem").filter({ hasText: incomeCat })).toBeVisible();

  // Record an expense to edit, into the private month.
  await clickCircleChromeTab(page, "Transactions");
  await selectMonth(page, month);
  await page.getByRole("link", { name: "Add expense" }).click();
  const addForm = page.getByRole("form", { name: /add expense/i });
  await addForm.getByLabel("Title").fill(title);
  await addForm.getByLabel(/Amount/).fill("10.00");
  await pickFormCategory(page, addForm, expenseCat);
  await addForm.getByRole("button", { name: "Add expense" }).click();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();

  // Edit: open the canonical edit object route (TXN-5), change the title + amount,
  // save, and see the row update live back on the ledger.
  await row.getByRole("link", { name: `Edit ${title}` }).click();
  // The ledger Edit link carries the ledger URL as `returnTo` (issue #123).
  await expect(page).toHaveURL(/\/transactions\/[^/]+\/edit\?returnTo=/);
  const editForm = page.getByRole("form", { name: /edit transaction/i });
  await editForm.getByLabel("Title").fill(editedTitle);
  await editForm.getByLabel(/Amount/).fill("25.00");
  await editForm.getByRole("button", { name: "Save changes" }).click();

  const editedRow = page.getByRole("listitem").filter({ hasText: editedTitle });
  await expect(editedRow).toBeVisible();
  await expect(editedRow).toContainText("-$25.00"); // still an expense, new amount

  // Type Change: switch to Income — confirm, re-pick the income category, save.
  await editedRow.getByRole("link", { name: `Edit ${editedTitle}` }).click();
  const typeForm = page.getByRole("form", { name: /edit transaction/i });
  await typeForm.getByRole("button", { name: "Income" }).click();
  await typeForm.getByRole("alertdialog").getByRole("button", { name: "Change type" }).click();
  // The old expense category is gone; pick the income one before saving.
  await expect(
    typeForm.getByRole("button", { name: new RegExp(`Remove ${expenseCat}`) }),
  ).toHaveCount(0);
  await pickFormCategory(page, typeForm, incomeCat);
  await typeForm.getByRole("button", { name: "Save changes" }).click();

  const incomeRow = page.getByRole("listitem").filter({ hasText: editedTitle });
  await expect(incomeRow).toContainText("+$25.00"); // flipped to income
  await expect(incomeRow).toContainText(incomeCat);
});

/**
 * TXN-3 true-E2E: archive then restore a Transaction through the real frontend →
 * `archiveTransaction` / `restoreTransaction` mutations → DB → reactive list. An
 * archived Transaction leaves the active Ledger and appears (frozen — no Edit) in the
 * Archived view; restoring returns it to the active list. A private far-future month
 * per project keeps the parallel runs from colliding on the shared Personal Circle.
 */
test("a member archives and restores a transaction", async ({ page }, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `E2E A ${stamp}`; // ≤ 40 chars (categoryNameMax)
  const title = `E2E Archive ${stamp}`;
  const month = testInfo.project.name === "mobile-chromium" ? "2996-06" : "2996-05";

  await openPersonalCircleFromHome(page);

  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: categoryName });
  await expect(page.getByRole("listitem").filter({ hasText: categoryName })).toBeVisible();

  // Record an expense into the private month.
  await clickCircleChromeTab(page, "Transactions");
  await selectMonth(page, month);
  await page.getByRole("link", { name: "Add expense" }).click();
  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Amount/).fill("8.00");
  await pickFormCategory(page, form, categoryName);
  await form.getByRole("button", { name: "Add expense" }).click();

  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  // Active row: editable, with no archived marker.
  await expect(row.getByRole("link", { name: `Edit ${title}` })).toBeVisible();
  await expect(row.getByText("Archived", { exact: true })).toHaveCount(0);

  // Archive it — the default (status=all) view keeps the row reactively but now distinguishes
  // it: an "Archived" marker, a Restore action, and no Edit affordance (frozen).
  await archiveWithDoubleCheck(row, title);
  await expect(row.getByText("Archived", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: `Restore ${title}` })).toBeVisible();
  await expect(row.getByRole("link", { name: `Edit ${title}` })).toHaveCount(0);

  // Narrowing to Active drops it from view; the Archived filter shows it, frozen (no Edit).
  await applyLedgerStatus(page, "active");
  await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
  await applyLedgerStatus(page, "archived");
  await expect(page).toHaveURL(/status=archived/);
  const archivedRow = page.getByRole("listitem").filter({ hasText: title });
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow.getByRole("link", { name: `Edit ${title}` })).toHaveCount(0);

  // Restore it — it leaves the Archived view; back in Active it is editable again, unmarked.
  await archivedRow.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
  await applyLedgerStatus(page, "active");
  const restoredRow = page.getByRole("listitem").filter({ hasText: title });
  await expect(restoredRow).toBeVisible();
  await expect(restoredRow.getByText("Archived", { exact: true })).toHaveCount(0);
  await expect(restoredRow.getByRole("link", { name: `Edit ${title}` })).toBeVisible();
});

/**
 * TXN-5 true-E2E: the Transactions page is URL-restorable. The selected Monthly Ledger
 * month, the Add form, and an edit deep link all survive a full reload — proving the
 * URL (not transient React state) owns navigation (ADR 0017) against the real router
 * and self-hosted backend. Uses a private far-future month per project so the parallel
 * runs never collide on the shared Personal Circle.
 */
test("the transactions page restores month, add form, and edit link across reload", async ({
  page,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `E2E U ${stamp}`; // ≤ 40 chars (categoryNameMax)
  const title = `E2E URL ${stamp}`;
  const month = testInfo.project.name === "mobile-chromium" ? "2998-04" : "2998-03";

  await openPersonalCircleFromHome(page);

  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: categoryName });
  await expect(page.getByRole("listitem").filter({ hasText: categoryName })).toBeVisible();

  // A bare Transactions route normalizes to a month in the URL.
  await clickCircleChromeTab(page, "Transactions");
  await expect(page).toHaveURL(/\/transactions\?month=\d{4}-\d{2}/);

  // Select the private month; the URL owns it and survives reload.
  await selectMonth(page, month);
  await expect(page).toHaveURL(new RegExp(`month=${month}`));
  await page.reload();
  await expect(page.getByLabel("Month", { exact: true })).toHaveValue(month);

  // Add expense navigates to the dedicated create route, carrying the month + the ledger
  // URL as returnTo (issue #96); the create page survives a reload (its state is in the URL).
  await page.getByRole("link", { name: "Add expense" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/transactions/new\\?type=expense&month=${month}&returnTo=.*month%3D${month}`),
  );
  await page.reload();
  await expect(page.getByRole("form", { name: /add expense/i })).toBeVisible();

  // Record into the private month, then open its edit deep link and reload it.
  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Amount/).fill("9.00");
  await pickFormCategory(page, form, categoryName);
  await form.getByRole("button", { name: "Add expense" }).click();

  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: `Edit ${title}` }).click();
  // The Edit link's `returnTo` is the ledger URL, which carries the month (encoded).
  await expect(page).toHaveURL(
    new RegExp(`/transactions/[^/]+/edit\\?returnTo=.*month%3D${month}`),
  );
  // The edit form is fetched by id, so a reload reopens it on the latest server values.
  await page.reload();
  await expect(
    page.getByRole("form", { name: /edit transaction/i }).getByLabel("Title"),
  ).toHaveValue(title);

  // Closing returns to the ledger with the same month preserved.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(new RegExp(`/transactions\\?month=${month}`));
  await expect(row).toBeVisible();
});

/**
 * TXN-4 true-E2E: the Transaction detail object route shows Audit Metadata + a live
 * Transaction History reflecting real actions. Records → edits → opens the detail and sees
 * the created + edited events with Audit Metadata, then archives and re-opens the detail to
 * see the archived event — all against the real frontend → Convex → DB → reactive history
 * read path. A private far-future month per project keeps the parallel runs from colliding
 * on the shared Personal Circle.
 */
test("the transaction detail shows audit metadata and history reflecting an edit and an archive", async ({
  page,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `E2E D ${stamp}`; // ≤ 40 chars (categoryNameMax)
  const title = `E2E Detail ${stamp}`;
  const month = testInfo.project.name === "mobile-chromium" ? "2994-06" : "2994-05";

  await openPersonalCircleFromHome(page);

  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: categoryName });
  await expect(page.getByRole("listitem").filter({ hasText: categoryName })).toBeVisible();

  // Record an expense into the private month.
  await clickCircleChromeTab(page, "Transactions");
  await selectMonth(page, month);
  await page.getByRole("link", { name: "Add expense" }).click();
  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Amount/).fill("10.00");
  await pickFormCategory(page, form, categoryName);
  await form.getByRole("button", { name: "Add expense" }).click();

  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();

  // Edit just the amount (the title — and so the detail link — stays stable) to record an
  // "edited" event with an amount change.
  await row.getByRole("link", { name: `Edit ${title}` }).click();
  const editForm = page.getByRole("form", { name: /edit transaction/i });
  await editForm.getByLabel(/Amount/).fill("25.00");
  await editForm.getByRole("button", { name: "Save changes" }).click();
  const editedRow = page.getByRole("listitem").filter({ hasText: title });
  await expect(editedRow).toContainText("-$25.00");

  // Archive it → an "archived" event. The default (status=all) view keeps the row but marks
  // it archived: a Restore action replaces Archive.
  await archiveWithDoubleCheck(editedRow, title);
  await expect(editedRow.getByRole("button", { name: `Restore ${title}` })).toBeVisible();

  // Open the archived Transaction's detail (via its title link, available on archived rows
  // too) and see its Audit Metadata + the full history: created, edited, and archived.
  await applyLedgerStatus(page, "archived");
  const archivedRow = page.getByRole("listitem").filter({ hasText: title });
  await archivedRow.getByRole("link", { name: `View ${title}` }).click();
  // The detail link carries the ledger URL (with its month) as `returnTo` (issue #123).
  await expect(page).toHaveURL(new RegExp(`/transactions/[^/]+\\?returnTo=.*month%3D${month}`));
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  const audit = page.getByRole("region", { name: "Audit metadata" });
  await expect(audit).toContainText("Created by");
  await expect(audit).toContainText("Last updated by");
  await expect(audit).toContainText("UTC"); // stored-zone, never the viewer timezone

  const history = page.getByRole("region", { name: "History" });
  await expect(history).toContainText("created");
  await expect(history).toContainText("edited");
  await expect(history).toContainText("archived");
  // The money change rendered as a formatted amount, not a raw id or minor-unit integer.
  await expect(history).toContainText("$25.00");
});

/**
 * TXN-4 UX: opening the editor FROM the detail page returns to that detail page on close
 * (Cancel or a successful save), not the Ledger — so a Ledger → Detail → Edit → close trip
 * lands back on Detail. Covers the full real nav round-trip end to end; a private far-future
 * month per project keeps parallel runs off the shared Personal Circle.
 */
test("editing from the transaction detail returns to the detail on cancel and on save", async ({
  page,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `E2E R ${stamp}`; // ≤ 40 chars (categoryNameMax)
  const title = `E2E Return ${stamp}`;
  const month = testInfo.project.name === "mobile-chromium" ? "2995-06" : "2995-05";

  await openPersonalCircleFromHome(page);

  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: categoryName });
  await expect(page.getByRole("listitem").filter({ hasText: categoryName })).toBeVisible();

  // Record an expense into the private month, then open its detail page.
  await clickCircleChromeTab(page, "Transactions");
  await selectMonth(page, month);
  await expect(page).toHaveURL(new RegExp(`month=${month}`));
  await page.getByRole("link", { name: "Add expense" }).click();
  const form = page.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Amount/).fill("10.00");
  await pickFormCategory(page, form, categoryName);
  await form.getByRole("button", { name: "Add expense" }).click();

  const row = page.getByRole("listitem").filter({ hasText: title });
  await row.getByRole("link", { name: `View ${title}` }).click();
  // The detail link carries the ledger URL (with its month) as `returnTo` (issue #123);
  // editing from here returns to this exact detail URL, so the same matcher holds after.
  const detailUrl = new RegExp(`/transactions/[^/]+\\?returnTo=.*month%3D${month}`);
  await expect(page).toHaveURL(detailUrl);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  // Edit → Cancel returns HERE (the detail), not the Ledger.
  await page.getByRole("link", { name: `Edit ${title}` }).click();
  await expect(page.getByRole("form", { name: /edit transaction/i })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  // Edit → Save also returns to the detail, now reflecting the new amount.
  await page.getByRole("link", { name: `Edit ${title}` }).click();
  const editForm = page.getByRole("form", { name: /edit transaction/i });
  await editForm.getByLabel(/Amount/).fill("25.00");
  await editForm.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.getByText("-$25.00")).toBeVisible();
});
