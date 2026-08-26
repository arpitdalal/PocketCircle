import type { Page } from "@playwright/test";
import {
  applyLedgerStatus,
  archiveWithDoubleCheck,
  clickCircleChromeTab,
  createCategoryViaForm,
  createRegularCircleAndFinishSetup,
  createSecondaryBrowserContext,
  establishE2ESession,
  expect,
  memberListItems,
  pickFormCategory,
  seedActiveMemberOnCircle,
  test,
} from "./fixtures.js";

const E2E_PASSWORD = "e2e-Password-123";

async function recordExpenseAsMember(
  memberPage: Page,
  { categoryName, title }: { categoryName: string; title: string },
) {
  await clickCircleChromeTab(memberPage, "Categories");
  await createCategoryViaForm(memberPage, { name: categoryName });
  await expect(memberPage.getByRole("listitem").filter({ hasText: categoryName })).toBeVisible();

  await clickCircleChromeTab(memberPage, "Transactions");
  await memberPage.getByRole("link", { name: "Add expense" }).click();
  const form = memberPage.getByRole("form", { name: /add expense/i });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel(/Amount/).fill("12.50");
  await pickFormCategory(memberPage, form, categoryName);
  await form.getByRole("button", { name: "Save" }).click();

  const row = memberPage.getByRole("listitem").filter({ hasText: title });
  await expect(row).toBeVisible();
  return row;
}

/**
 * QA-1 true-E2E (ADR 0019): two real browser sessions interleave on the same
 * Transaction against the self-hosted backend. Scenario 1 proves live revocation
 * when an Owner archives while the Recorder is mid-edit; Scenario 2 proves the
 * client blocks a stale Paid By after the target Member is removed mid-edit.
 */
test("owner archives while recorder is mid-edit — live eject, no corruption", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const aEmail = `e2e-qa1-a-${stamp}@example.com`;
  const circleName = `E2E QA1 Archive ${stamp}`;
  const categoryName = `E2E QC ${stamp}`; // ≤ 40 chars (categoryNameMax)
  const title = `E2E QT ${stamp}`;
  const unsavedTitle = `${title} x`;

  const memberContext = await createSecondaryBrowserContext(browser, testInfo);
  const memberPage = await memberContext.newPage();
  await establishE2ESession(memberPage, {
    baseURL: baseURL ?? "http://127.0.0.1:5173",
    email: aEmail,
    password: E2E_PASSWORD,
    name: "Member A",
  });

  await createRegularCircleAndFinishSetup(page, { name: circleName });
  const circleUrl = page.url();
  await seedActiveMemberOnCircle(page, aEmail, "Member A");

  await memberPage.goto(circleUrl);
  await recordExpenseAsMember(memberPage, { categoryName, title });

  await page.goto(circleUrl);
  await clickCircleChromeTab(page, "Transactions");
  const ownerRow = page.getByRole("listitem").filter({ hasText: title });
  await expect(ownerRow).toBeVisible();

  const memberRow = memberPage.getByRole("listitem").filter({ hasText: title });
  await memberRow.getByRole("link", { name: `Edit ${title}` }).click();
  const editForm = memberPage.getByRole("form", { name: /edit transaction/i });
  await expect(editForm).toBeVisible();
  await editForm.getByLabel("Title").fill(unsavedTitle);

  await archiveWithDoubleCheck(ownerRow, title);
  await expect(ownerRow.getByText("Archived", { exact: true })).toBeVisible();

  await expect(memberPage.getByText("That link isn't available.")).toBeVisible();
  await expect(memberPage).toHaveURL(/\/transactions(?:\?|$)/);
  await expect(memberPage.getByRole("form", { name: /edit transaction/i })).toHaveCount(0);

  await applyLedgerStatus(memberPage, "archived");
  const archivedRow = memberPage.getByRole("listitem").filter({ hasText: title });
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow.getByText("Archived", { exact: true })).toBeVisible();
  await expect(archivedRow.getByRole("link", { name: `Edit ${title}` })).toHaveCount(0);
  await expect(memberPage.getByRole("listitem").filter({ hasText: unsavedTitle })).toHaveCount(0);

  await memberContext.close();
});

test("paid by target removed mid-edit — client blocks save", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const aEmail = `e2e-qa1-paid-a-${stamp}@example.com`;
  const mEmail = `e2e-qa1-paid-m-${stamp}@example.com`;
  const circleName = `E2E QA1 PaidBy ${stamp}`;
  const categoryName = `E2E QP ${stamp}`; // ≤ 40 chars (categoryNameMax)
  const title = `E2E QPB ${stamp}`;

  const memberContext = await createSecondaryBrowserContext(browser, testInfo);
  const memberPage = await memberContext.newPage();
  await establishE2ESession(memberPage, {
    baseURL: baseURL ?? "http://127.0.0.1:5173",
    email: aEmail,
    password: E2E_PASSWORD,
    name: "Member A",
  });

  await createRegularCircleAndFinishSetup(page, { name: circleName });
  const circleUrl = page.url();
  await seedActiveMemberOnCircle(page, aEmail, "Member A");
  await seedActiveMemberOnCircle(page, mEmail, "Payer M");

  await memberPage.goto(circleUrl);
  const row = await recordExpenseAsMember(memberPage, { categoryName, title });
  await expect(row).toContainText("Member A");

  await row.getByRole("link", { name: `Edit ${title}` }).click();
  const form = memberPage.getByRole("form", { name: /edit transaction/i });
  await expect(form).toBeVisible();
  await form.getByLabel("Paid by").selectOption({ label: "Payer M" });

  await page.goto(circleUrl);
  await clickCircleChromeTab(page, "Members");
  await page.getByRole("button", { name: "Remove Payer M" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove member" }).click();
  await expect(memberListItems(page).filter({ hasText: "Payer M" })).toHaveCount(0);

  // Wait for A's reactive `listMembers` to drop M before submit — otherwise the
  // client still sees a current Member and the mutation races the removal.
  await expect(form.getByLabel("Paid by").locator("option", { hasText: "Payer M" })).toHaveCount(0);

  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "The selected payer is no longer a member of this circle. Pick a current member.",
  );

  await form.getByRole("button", { name: "Cancel" }).click();
  await clickCircleChromeTab(memberPage, "Transactions");
  const unchangedRow = memberPage.getByRole("listitem").filter({ hasText: title });
  await expect(unchangedRow).toBeVisible();
  await expect(unchangedRow).toContainText("Member A");
  await expect(unchangedRow).not.toContainText("Payer M");

  await memberContext.close();
});
