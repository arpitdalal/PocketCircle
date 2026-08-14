import type { Browser, Page } from "@playwright/test";
import {
  createIsolatedBrowserContext,
  createRegularCircleAndFinishSetup,
  establishE2ESession,
  expect,
  finishCircleSetup,
  inviteMemberByEmail,
  pickFormCategory,
  test,
} from "./fixtures.js";

async function openPersonalDashboard(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your circles" })).toBeVisible();
  await page.getByRole("link", { name: /Ada's Circle/ }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
}

async function openIsolatedActivationSession(
  browser: Browser,
  baseURL: string | undefined,
  email: string,
) {
  const resolvedBase = typeof baseURL === "string" && baseURL ? baseURL : "http://127.0.0.1:5173";
  const context = await createIsolatedBrowserContext(browser);
  const page = await context.newPage();
  await establishE2ESession(page, { baseURL: resolvedBase, email, name: "Ada E2E" });
  return { context, page, resolvedBase };
}

/**
 * TRUE-E2E (ADR 0019 / #265): isolated Users so the worker-shared session cannot
 * pre-complete Activation Checklist items.
 */
test("skip hides the Personal checklist across reload; regular Dashboard never shows it", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openIsolatedActivationSession(
    browser,
    baseURL,
    `e2e+activation-skip-${Date.now()}@example.com`,
  );
  try {
    await openPersonalDashboard(page);

    const checklist = page.getByRole("region", { name: "Get started" });
    await expect(checklist).toBeVisible();
    await expect(checklist.getByText("0 of 4 complete")).toBeVisible();
    await checklist.getByRole("button", { name: "Skip onboarding" }).click();
    await expect(page.getByRole("heading", { name: "Get started" })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Get started" })).toHaveCount(0);

    await createRegularCircleAndFinishSetup(page, { name: `Act Skip ${Date.now()}` });
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Get started" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("checklist items complete in any order, pending stays waiting, accept hides the card", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const stamp = `${Date.now()}`;
  const categoryName = `Act ${stamp}`.slice(0, 40);
  const inviteeEmail = `e2e+activation-join-${stamp}@example.com`;
  const { context, page, resolvedBase } = await openIsolatedActivationSession(
    browser,
    baseURL,
    `e2e+activation-${stamp}@example.com`,
  );
  try {
    await openPersonalDashboard(page);

    const checklist = page.getByRole("region", { name: "Get started" });
    await expect(checklist).toBeVisible();
    await checklist.getByRole("link", { name: "New category" }).click();
    const categoryForm = page.getByRole("form", { name: "New category" });
    await categoryForm.getByLabel(/New expense category/).fill(categoryName);
    await categoryForm.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Get started" }).getByText("1 of 4 complete"),
    ).toBeVisible();

    await page
      .getByRole("region", { name: "Get started" })
      .getByRole("link", { name: "Add expense" })
      .click();
    const form = page.getByRole("form", { name: /add expense/i });
    await form.getByLabel("Title").fill(`Act spend ${stamp}`);
    await form.getByLabel(/Amount/).fill("4.50");
    await pickFormCategory(page, form, categoryName);
    await form.getByRole("button", { name: "Add expense" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Get started" }).getByText("2 of 4 complete"),
    ).toBeVisible();

    await page
      .getByRole("region", { name: "Get started" })
      .getByRole("link", { name: "Create circle" })
      .first()
      .click();
    await page.getByLabel("Name").fill(`Act Shared ${stamp}`);
    await page.getByRole("button", { name: "Create circle" }).click();
    await finishCircleSetup(page);

    await openPersonalDashboard(page);
    await expect(
      page.getByRole("region", { name: "Get started" }).getByText("3 of 4 complete"),
    ).toBeVisible();
    await page
      .getByRole("region", { name: "Get started" })
      .getByRole("link", { name: "Invite a member" })
      .click();
    await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
    await expect(page.getByRole("form", { name: "Invite member" })).toBeVisible();
    const token = await inviteMemberByEmail(page, inviteeEmail);

    await openPersonalDashboard(page);
    const activation = page.getByRole("region", { name: "Get started" });
    await expect(activation.getByText("Invitation pending")).toBeVisible();
    await expect(activation.getByText("3 of 4 complete")).toBeVisible();

    const inviteeContext = await createIsolatedBrowserContext(browser);
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

    await openPersonalDashboard(page);
    await expect(page.getByRole("heading", { name: "Get started" })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
