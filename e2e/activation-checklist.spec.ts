import type { Browser, Page, TestInfo } from "@playwright/test";
import {
  appBaseUrl,
  createRegularCircleAndFinishSetup,
  createSecondaryBrowserContext,
  establishE2ESession,
  expect,
  expectNoActivationChecklist,
  finishCircleSetup,
  homeCircleCard,
  inviteMemberByEmail,
  isSidebarViewport,
  openActivationChecklist,
  pickFormCategory,
  returnFromTransactionDetail,
  saveButton,
  selectGlobalAddCircle,
  test,
} from "./fixtures.js";

async function openHome(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your circles" })).toBeVisible();
}

async function openPersonalDashboard(page: Page) {
  await openHome(page);
  await homeCircleCard(page, /Ada's Circle/).click();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
}

/**
 * Isolated User, project device. The band decides which presentation exists at all
 * (issue #351), so a context that dropped `project.use` would run the desktop flyout
 * under the mobile project and never exercise the Home card.
 */
async function openIsolatedActivationSession(
  browser: Browser,
  testInfo: TestInfo,
  baseURL: string | undefined,
  email: string,
) {
  const resolvedBase = appBaseUrl(baseURL);
  const context = await createSecondaryBrowserContext(browser, testInfo);
  const page = await context.newPage();
  await establishE2ESession(page, { baseURL: resolvedBase, email, name: "Ada E2E" });
  return { context, page, resolvedBase };
}

/**
 * TRUE-E2E (ADR 0019 / #265 / #273): isolated Users so the worker-shared session cannot
 * pre-complete Activation Checklist items. Both presentations run the same flows —
 * the Home card below `lg`, the sidebar flyout above it (issue #351).
 */
test("skip hides the checklist across reload and route changes", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000);
  const { context, page } = await openIsolatedActivationSession(
    browser,
    testInfo,
    baseURL,
    `e2e+activation-skip-${Date.now()}@example.com`,
  );
  try {
    await openHome(page);

    const checklist = await openActivationChecklist(page);
    await expect(checklist.getByText("0 of 4 complete")).toBeVisible();
    await checklist.getByRole("button", { name: "Skip onboarding" }).click();
    await expectNoActivationChecklist(page);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expectNoActivationChecklist(page);

    await openPersonalDashboard(page);
    await expectNoActivationChecklist(page);

    await createRegularCircleAndFinishSetup(page, { name: `Act Skip ${Date.now()}` });
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expectNoActivationChecklist(page);

    await openHome(page);
    await expectNoActivationChecklist(page);
  } finally {
    await context.close();
  }
});

// Where an ELIGIBLE checklist is reachable differs by band: the Home feed owns the card,
// while the sidebar launcher follows the User onto every authenticated route (#351).
test("an eligible checklist follows desktop routes and stays on Home for narrow viewports", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60_000);
  const { context, page } = await openIsolatedActivationSession(
    browser,
    testInfo,
    baseURL,
    `e2e+activation-scope-${Date.now()}@example.com`,
  );
  try {
    await openHome(page);
    await openActivationChecklist(page);

    await openPersonalDashboard(page);
    if (isSidebarViewport(page)) {
      const flyout = await openActivationChecklist(page);
      await expect(flyout.getByText("0 of 4 complete")).toBeVisible();
    } else {
      await expect(page.getByRole("region", { name: "Get started" })).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
});

test("checklist items complete in any order, pending stays waiting, accept hides the card", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000);
  const stamp = `${Date.now()}`;
  const categoryName = `Act ${stamp}`.slice(0, 40);
  const inviteeEmail = `e2e+activation-join-${stamp}@example.com`;
  const { context, page, resolvedBase } = await openIsolatedActivationSession(
    browser,
    testInfo,
    baseURL,
    `e2e+activation-${stamp}@example.com`,
  );
  try {
    await openHome(page);

    const checklist = await openActivationChecklist(page);
    await checklist.getByRole("link", { name: "New category" }).click();
    const categoryForm = page.getByRole("form", { name: "New category" });
    await categoryForm.getByLabel(/New expense category/).fill(categoryName);
    await saveButton(categoryForm).click();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect((await openActivationChecklist(page)).getByText("1 of 4 complete")).toBeVisible();

    await (await openActivationChecklist(page)).getByRole("link", { name: "Add expense" }).click();
    await expect(page.getByRole("heading", { name: "Add transaction" })).toBeVisible();
    await selectGlobalAddCircle(page, /Ada's Circle/);
    const form = page.getByRole("form", { name: /add expense/i });
    await form.getByLabel("Title").fill(`Act spend ${stamp}`);
    await form.getByLabel(/Amount/).fill("4.50");
    await pickFormCategory(page, form, categoryName);
    await saveButton(form).click();
    await expect(page.getByRole("heading", { level: 2, name: `Act spend ${stamp}` })).toBeVisible();
    await returnFromTransactionDetail(page);
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect((await openActivationChecklist(page)).getByText("2 of 4 complete")).toBeVisible();

    await (await openActivationChecklist(page))
      .getByRole("listitem")
      .filter({ hasText: "Create a shared Circle" })
      .getByRole("link", { name: "Create circle" })
      .click();
    await page.getByLabel("Name").fill(`Act Shared ${stamp}`);
    await page.getByRole("button", { name: "Create circle" }).click();
    await finishCircleSetup(page);

    await openHome(page);
    await expect((await openActivationChecklist(page)).getByText("3 of 4 complete")).toBeVisible();
    await (await openActivationChecklist(page))
      .getByRole("link", { name: "Invite a member" })
      .click();
    await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
    await expect(page.getByRole("form", { name: "Invite member" })).toBeVisible();
    const token = await inviteMemberByEmail(page, inviteeEmail);

    await openHome(page);
    const activation = await openActivationChecklist(page);
    await expect(activation.getByText("Invitation pending")).toBeVisible();
    await expect(activation.getByText("3 of 4 complete")).toBeVisible();

    const inviteeContext = await createSecondaryBrowserContext(browser, testInfo);
    const inviteePage = await inviteeContext.newPage();
    try {
      await establishE2ESession(inviteePage, {
        baseURL: resolvedBase,
        email: inviteeEmail,
        name: "Ivy Invitee",
      });
      await inviteePage.goto(`/invite/${token}`);
      await inviteePage.getByRole("button", { name: "Accept invitation" }).click();
      await inviteePage.waitForURL(/\/circles\/[^/]+-[^/]+(?:\/|$)/);
    } finally {
      await inviteeContext.close();
    }

    await openHome(page);
    await expectNoActivationChecklist(page);
  } finally {
    await context.close();
  }
});
