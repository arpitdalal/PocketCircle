import {
  circleSwitcher,
  clickCircleChromeTab,
  createRegularCircleAndFinishSetup,
  expect,
  inviteMemberByEmail,
  joinCircleViaInvitation,
  openPersonalCircleFromHome,
  test,
} from "./fixtures.js";

/**
 * TRUE-E2E (ADR 0019): leave-circle flows through the real Members surface →
 * `leaveCircle` mutation → reactive `listMyCircles` drop. Non-owner setup uses the
 * E2E-only invitation accept helper until MEM-3 ships the public accept path.
 */
test("a non-owner member leaves a regular circle and lands on home without it", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const resolvedBase = typeof baseURL === "string" && baseURL ? baseURL : "http://127.0.0.1:5173";
  const circleName = `E2E Leave ${Date.now()}`;
  const memberEmail = `e2e+leave-member-${Date.now()}@example.com`;

  await createRegularCircleAndFinishSetup(page, { name: circleName });
  const token = await inviteMemberByEmail(page, memberEmail);

  const { context: memberContext, page: memberPage } = await joinCircleViaInvitation({
    browser,
    baseURL: resolvedBase,
    memberEmail,
    memberName: "Leave Member",
    token,
  });

  try {
    await memberPage.goto(resolvedBase);
    await circleSwitcher(memberPage).click();
    await memberPage
      .getByRole("menu")
      .getByRole("menuitem", { name: new RegExp(circleName) })
      .click();

    await clickCircleChromeTab(memberPage, "Members");
    await expect(memberPage.getByRole("button", { name: "Leave Circle" })).toBeVisible();
    await memberPage.getByRole("button", { name: "Leave Circle" }).click();
    await memberPage.getByRole("button", { name: "Confirm Leave" }).click();

    await expect(memberPage.getByRole("heading", { name: "Your circles" })).toBeVisible();
    await expect(memberPage).toHaveURL((url) => url.pathname === "/");
    await circleSwitcher(memberPage).click();
    await expect(
      memberPage.getByRole("menu").getByRole("menuitem", { name: new RegExp(circleName) }),
    ).toHaveCount(0);
  } finally {
    await memberContext.close();
  }
});

test("the owner sees a transfer-first notice instead of a leave button", async ({ page }) => {
  const circleName = `E2E Owner Leave ${Date.now()}`;
  await createRegularCircleAndFinishSetup(page, { name: circleName });

  await clickCircleChromeTab(page, "Members");
  await expect(page.getByText(/transfer ownership before leaving/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Leave Circle" })).toHaveCount(0);
});

test("a personal circle shows no leave section", async ({ page }) => {
  await openPersonalCircleFromHome(page);
  await clickCircleChromeTab(page, "Members");
  await expect(page.getByRole("button", { name: "Leave Circle" })).toHaveCount(0);
  await expect(page.getByText(/transfer ownership before leaving/i)).toHaveCount(0);
});
