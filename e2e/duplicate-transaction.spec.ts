import {
  expect,
  inlineCreateFormCategory,
  localPlainDate,
  openHome,
  returnFromTransactionDetail,
  selectGlobalAddCircle,
  test,
} from "./fixtures.js";

/**
 * TRUE-E2E (ADR 0019 / issue #299 / parent #296 §20): source Transaction Detail
 * → reviewed Duplicate prefill → create → new Detail → source Detail → prior
 * origin. Exceptional-state permutations stay in the real-Router suite.
 */

test("Duplicate from Transaction Detail creates an independent Transaction and preserves the return chain", async ({
  page,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const categoryName = `Dup Cat ${stamp}`.slice(0, 40);
  const sourceTitle = `Dup Source ${stamp}`;
  const copyTitle = `Dup Copy ${stamp}`;

  // Capture today's plain date before navigation so a midnight boundary during
  // the run cannot fail a single-shot comparison. Do not freeze Playwright's
  // clock — setFixedTime pauses timers and breaks Convex/auth in TRUE-E2E.
  const dateAtStart = localPlainDate();

  await openHome(page);
  const homePathAndSearch = new URL(page.url()).pathname + new URL(page.url()).search;

  // Seed a source Transaction via Global Add so Detail has a real prior origin.
  await page.getByRole("link", { name: "Add transaction" }).click();
  await selectGlobalAddCircle(page);
  const createForm = page.getByRole("form", { name: /add expense/i });
  await createForm.getByLabel("Title").fill(sourceTitle);
  await createForm.getByLabel(/Amount/).fill("18.25");
  await createForm.getByLabel(/Note/).fill("Source note");
  await inlineCreateFormCategory(page, createForm, categoryName);
  await createForm.getByRole("button", { name: "Add expense" }).click();

  await expect(page.getByRole("heading", { level: 2, name: sourceTitle })).toBeVisible();
  const sourceDetailUrl = new URL(page.url());
  expect(sourceDetailUrl.pathname).toContain("/transactions/");
  expect(sourceDetailUrl.searchParams.get("returnTo")).toBe("/?currency=USD&range=3");

  // Duplicate opens Global Add with reviewed prefill (same destination).
  await page.getByRole("link", { name: `Duplicate transaction ${sourceTitle}` }).click();
  await expect(page.getByRole("heading", { name: "Add transaction" })).toBeVisible();
  const dupForm = page.getByRole("form", { name: /add expense/i });
  await expect(dupForm.getByLabel("Title")).toHaveValue(sourceTitle);
  await expect(dupForm.getByLabel(/Note/)).toHaveValue("Source note");
  await expect(dupForm.getByLabel(/Amount/)).toHaveValue("18.25");
  const dateValue = await dupForm.getByLabel("Date").inputValue();
  expect([dateAtStart, localPlainDate()]).toContain(dateValue);
  await expect(dupForm.getByRole("button", { name: `Remove ${categoryName}` })).toBeVisible();

  // Review: change Title so the new Transaction is distinct; source stays intact.
  await dupForm.getByLabel("Title").fill(copyTitle);
  await dupForm.getByRole("button", { name: "Add expense" }).click();

  await expect(page.getByRole("heading", { level: 2, name: copyTitle })).toBeVisible();
  const newDetail = new URL(page.url());
  expect(newDetail.pathname).toContain("/transactions/");
  expect(newDetail.pathname).not.toBe(sourceDetailUrl.pathname);
  // Success returnTo is the source Detail (with its Home origin nested).
  const nestedReturn = newDetail.searchParams.get("returnTo");
  expect(nestedReturn).toBeTruthy();
  expect(nestedReturn).toContain(sourceDetailUrl.pathname);

  // Back → source Detail; Back again → Home origin.
  await returnFromTransactionDetail(page);
  await expect(page.getByRole("heading", { level: 2, name: sourceTitle })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(sourceDetailUrl.pathname);

  await returnFromTransactionDetail(page);
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(homePathAndSearch);
});
