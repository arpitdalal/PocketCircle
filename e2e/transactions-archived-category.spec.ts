import {
  applyLedgerStatus,
  archiveWithDoubleCheck,
  assertLedgerRowStaysAbsent,
  clickCircleChromeTab,
  createCategoryViaForm,
  createRegularCircleAndFinishSetup,
  createSecondaryBrowserContext,
  establishE2ESession,
  expect,
  pickFormCategory,
  seedActiveMemberOnCircle,
  test,
} from "./fixtures.js";

const E2E_PASSWORD = "e2e-Password-123";

/**
 * QA-2 true-E2E (ADR 0019): when a Category selected in an open Create-Transaction
 * form is archived by the Owner before submit, the form keeps the chip visible
 * (badged archived), blocks submit with role="alert", and recovers after removal.
 * Server backstop: packages/convex/convex/transactions.test.ts ("rejects an archived category").
 */
test("category archived mid-creation — keep visible, block, recover", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const aEmail = `e2e-qa2-a-${stamp}@example.com`;
  const circleName = `E2E QA2 Cat ${stamp}`;
  const catPick = `E2E Q2P ${stamp}`; // ≤ 40 chars (categoryNameMax)
  const catSpare = `E2E Q2S ${stamp}`;
  const title = `E2E Q2T ${stamp}`;

  const memberContext = await createSecondaryBrowserContext(browser, testInfo);
  const aPage = await memberContext.newPage();
  await establishE2ESession(aPage, {
    baseURL: baseURL ?? "http://127.0.0.1:5173",
    email: aEmail,
    password: E2E_PASSWORD,
    name: "Member A",
  });

  // B (Owner): isolated Circle + two active expense Categories + Member A.
  await createRegularCircleAndFinishSetup(page, { name: circleName });
  const circleUrl = page.url();
  await seedActiveMemberOnCircle(page, aEmail, "Member A");

  await clickCircleChromeTab(page, "Categories");
  await createCategoryViaForm(page, { name: catPick });
  await expect(page.getByRole("listitem").filter({ hasText: catPick })).toBeVisible();
  await createCategoryViaForm(page, { name: catSpare });
  await expect(page.getByRole("listitem").filter({ hasText: catSpare })).toBeVisible();

  // A: open create form, pick CatPick while active — do not submit.
  await aPage.goto(circleUrl);
  await clickCircleChromeTab(aPage, "Transactions");
  await aPage.getByRole("link", { name: "Add expense" }).click();
  const aForm = aPage.getByRole("form", { name: /add expense/i });
  await aForm.getByLabel("Title").fill(title);
  await aForm.getByLabel(/Amount/).fill("12.50");
  await pickFormCategory(aPage, aForm, catPick);
  await expect(aForm.getByRole("button", { name: `Remove ${catPick}` })).toBeVisible();
  await expect(aForm.getByText(/ · archived/)).toHaveCount(0);

  // B: archive CatPick; await ordered completion before A asserts the reactive flip.
  await clickCircleChromeTab(page, "Categories");
  await archiveWithDoubleCheck(page, catPick);
  const archivedRow = page.getByRole("listitem").filter({ hasText: catPick });
  await expect(archivedRow.getByText("Archived", { exact: true })).toBeVisible();

  // A's open form (no reload): chip stays selected, now badged archived + alert.
  await expect(aForm.getByText(new RegExp(`${escapeRegExp(catPick)} · archived`))).toBeVisible();
  await expect(aForm.getByRole("button", { name: `Remove ${catPick}` })).toBeVisible();
  await expect(aForm.getByRole("alert")).toHaveText(
    `"${catPick}" was archived and can't be added to a expense. Remove it to continue.`,
  );

  // A: submit blocked — alert persists; ledger (Owner B's view) never gains the Transaction.
  await aForm.getByRole("button", { name: "Save" }).click();
  await expect(aForm.getByRole("alert")).toHaveText(
    `"${catPick}" was archived and can't be added to a expense. Remove it to continue.`,
  );
  await clickCircleChromeTab(page, "Transactions");
  await applyLedgerStatus(page, "active");
  await assertLedgerRowStaysAbsent(page, title);

  // A: recover — remove archived chip; blocking alert clears, then pick CatSpare and submit.
  await aForm.getByRole("button", { name: `Remove ${catPick}` }).click();
  await expect(aForm.getByText(new RegExp(`${escapeRegExp(catPick)} · archived`))).toHaveCount(0);
  await expect(
    aForm.getByText(
      `"${catPick}" was archived and can't be added to a expense. Remove it to continue.`,
    ),
  ).toHaveCount(0);
  await pickFormCategory(aPage, aForm, catSpare);
  await aForm.getByRole("button", { name: "Save" }).click();
  const row = aPage.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();

  await memberContext.close();
});

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
