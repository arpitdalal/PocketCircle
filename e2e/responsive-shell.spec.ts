import type { Locator, Page } from "@playwright/test";
import {
  circleChromeNav,
  circleSwitcher,
  clickCircleChromeTab,
  expect,
  homeCircleCard,
  test,
} from "./fixtures.js";

/**
 * Responsive shell chrome (issue #351). Viewports are pinned per describe rather than
 * inherited from the project so each band is asserted in every project run: which chrome
 * paints is decided by CSS width alone, never by the emulated device.
 *
 * `exact` on the nav names is load-bearing — "Circle" substring-matches "Circle tabs".
 */
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const TABLET_VIEWPORT = { width: 900, height: 800 };
const PHONE_VIEWPORT = { width: 390, height: 844 };

function sidebarNav(page: Page) {
  return page.getByRole("navigation", { name: "Primary", exact: true });
}

async function openPersonalCircleDashboard(page: Page) {
  await page.goto("/");
  await homeCircleCard(page, /Your Circle/).click();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
}

test.describe("desktop shell", () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test("navigates from the sidebar with no top header or horizontal tabs", async ({ page }) => {
    await openPersonalCircleDashboard(page);

    // The sidebar owns brand, switcher, Home, and the Circle destinations. The header
    // and the narrow Circle navs are `display: none`, so they are absent from the
    // accessibility tree — asserted by count, since `toBeHidden` also passes for chrome
    // that was never rendered and would keep passing if the whole shell regressed.
    await expect(sidebarNav(page)).toBeVisible();
    await expect(circleSwitcher(page)).toBeVisible();
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Circle tabs", exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Circle", exact: true })).toHaveCount(0);

    const circleGroup = circleChromeNav(page);
    await expect(circleGroup.getByRole("link", { name: "Dashboard", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await circleGroup.getByRole("link", { name: "Transactions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
    await expect(
      circleGroup.getByRole("link", { name: "Transactions", exact: true }),
    ).toHaveAttribute("aria-current", "page");

    // Shell navigation keeps the sidebar mounted; the Circle group drops off Home.
    await sidebarNav(page).getByRole("link", { name: "Home", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your circles" })).toBeVisible();
    await expect(sidebarNav(page)).toBeVisible();
    await expect(circleGroup).toHaveCount(0);
  });

  test("skip link still reaches main content ahead of the sidebar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your circles" })).toBeVisible();

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("opens the condensed changelog and sends the archive to a new tab", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your circles" })).toBeVisible();

    await page.getByRole("button", { name: /What's new/ }).click();
    const feed = page.getByRole("dialog", { name: "What's new" });
    await expect(feed).toBeVisible();
    // Opening focus lands on the dialog itself, not on the archive link inside it, so
    // Enter reads the feed instead of immediately leaving for another tab.
    await expect(feed).toBeFocused();

    const viewAll = feed.getByRole("link", { name: /View all updates/ });
    await expect(viewAll).toHaveAttribute("target", "_blank");
    await expect(viewAll).toHaveAttribute("rel", "noopener noreferrer");

    const [archive] = await Promise.all([page.context().waitForEvent("page"), viewAll.click()]);
    await expect(archive.getByRole("heading", { name: "What's new" })).toBeVisible();
    await archive.close();

    // Reading the archive never navigated the app tab away from the task in progress.
    await expect(page).toHaveURL((url) => url.pathname === "/");

    // A dialog needs a control in its own tab sequence: a touch screen-reader user has
    // neither Escape nor an outside click.
    await feed.getByRole("button", { name: "Close" }).click();
    await expect(feed).toBeHidden();
    await expect(page.getByRole("button", { name: /What's new/ })).toBeFocused();
  });
});

test.describe("tablet shell", () => {
  // Between `sm` and `lg`: the header still paints, the Circle nav is the horizontal tab
  // strip rather than the bottom bar, and the sidebar is still absent.
  test.use({ viewport: TABLET_VIEWPORT });

  test("keeps the sticky header with horizontal Circle tabs and no sidebar", async ({ page }) => {
    await openPersonalCircleDashboard(page);

    await expect(page.getByRole("banner")).toBeVisible();
    await expect(sidebarNav(page)).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Circle", exact: true })).toHaveCount(0);

    const tabs = circleChromeNav(page);
    await expect(tabs).toBeVisible();
    await tabs.getByRole("link", { name: "Transactions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Transactions", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

test.describe("phone shell", () => {
  test.use({ viewport: PHONE_VIEWPORT });

  test("keeps the sticky header and Circle bottom navigation, with no sidebar", async ({
    page,
  }) => {
    await openPersonalCircleDashboard(page);

    await expect(page.getByRole("banner")).toBeVisible();
    await expect(sidebarNav(page)).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Circle tabs", exact: true })).toHaveCount(0);

    const bottomNav = circleChromeNav(page);
    await expect(bottomNav).toBeVisible();
    await bottomNav.getByRole("link", { name: "Transactions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible();
    await expect(page.getByRole("banner")).toBeVisible();
  });

  test("phone form controls render at least 16px", async ({ page }) => {
    async function expectTouchSafeControl(control: Locator) {
      await expect(control).toBeVisible();
      await expect
        .poll(() =>
          control.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
        )
        .toBeGreaterThanOrEqual(16);
    }

    await openPersonalCircleDashboard(page);

    await clickCircleChromeTab(page, "Transactions");
    await expectTouchSafeControl(page.getByLabel("Month", { exact: true }));
    await page.getByRole("link", { name: "Add expense" }).click();
    const form = page.getByRole("form", { name: /add expense/i });
    await expectTouchSafeControl(form.getByLabel("Title"));
    await expectTouchSafeControl(form.getByLabel(/Amount/));
    await expectTouchSafeControl(form.getByLabel("Date"));
    await expectTouchSafeControl(form.getByLabel("Note"));
    await expectTouchSafeControl(form.getByRole("combobox", { name: "Categories" }));
    await expectTouchSafeControl(form.getByLabel("Paid by"));

    await clickCircleChromeTab(page, "Search");
    await expectTouchSafeControl(page.getByRole("searchbox", { name: "Search title or note" }));

    await page.getByRole("button", { name: /Filters/ }).click();
    const filters = page.getByRole("dialog", { name: "Filters" });
    await expectTouchSafeControl(filters.getByLabel("From"));
    await expectTouchSafeControl(filters.getByLabel("To", { exact: true }));
    await expectTouchSafeControl(filters.getByLabel("Amount min"));
    await expectTouchSafeControl(filters.getByLabel("Amount max"));
    await expectTouchSafeControl(filters.getByRole("combobox", { name: "Categories" }));
  });
});
