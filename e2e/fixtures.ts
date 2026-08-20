import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import { test as base, expect } from "@playwright/test";

const SM_BREAKPOINT_PX = 640;

export type CircleChromeTab = "Dashboard" | "Transactions" | "Search" | "Categories" | "Members";

/** Member rows only — excludes pending-invitation `<li>`s on the Members page. */
export function memberListItems(page: Page) {
  return page.getByRole("list", { name: "Circle members" }).getByRole("listitem");
}

/** Pending invitation rows on the Members page (owner-only). */
export function pendingInvitationListItems(page: Page) {
  return page.getByRole("region", { name: "Pending invitations" }).getByRole("listitem");
}

/** `installE2EAuthHelper` runs from entry.client after hydration — wait before any in-page API bridge call. */
export async function waitForScE2E(page: Page) {
  await page.waitForFunction(() => "__scE2E" in globalThis, { timeout: 30_000 });
}

/** Circle route mounted + Better Auth session wired into the Convex client (after navigation). */
export async function ensureCircleConvexReady(page: Page) {
  await page.waitForURL(/\/circles\/[^/]+/);
  await expect(
    page
      .getByRole("navigation", { name: "Circle tabs" })
      .or(page.getByRole("navigation", { name: "Circle" })),
  ).toBeVisible({ timeout: 30_000 });
  await waitForScE2E(page);
}

export async function invokeScE2E<T>(page: Page, method: string, args: unknown[] = []) {
  await ensureCircleConvexReady(page);
  return page.evaluate<T>(
    async ([name, methodArgs]) => {
      const helper = Reflect.get(globalThis, "__scE2E");
      if (typeof helper !== "object" || helper === null) {
        throw new Error("missing __scE2E");
      }
      const fn = Reflect.get(helper, name);
      if (typeof fn !== "function") {
        throw new Error(`missing ${name}`);
      }
      return Reflect.apply(fn, helper, methodArgs);
    },
    [method, args],
  );
}

export async function seedActiveMemberOnCircle(page: Page, email: string, displayName: string) {
  return invokeScE2E<{ memberId: string }>(page, "seedActiveMember", [email, displayName]);
}

export type RemoveMemberProbeResult = { ok: true } | { ok: false; message: string; data: unknown };

/** Permission probes: returns mutation outcome without throwing through Playwright. */
export async function probeRemoveMember(page: Page, memberId: string) {
  await ensureCircleConvexReady(page);
  return page.evaluate(async (id) => {
    const helper = Reflect.get(globalThis, "__scE2E");
    if (typeof helper !== "object" || helper === null) {
      throw new Error("missing __scE2E");
    }
    const remove = Reflect.get(helper, "removeMember");
    if (typeof remove !== "function") {
      throw new Error("missing removeMember");
    }
    try {
      await Reflect.apply(remove, helper, [id]);
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        message: err instanceof Error ? err.message : String(err),
        data:
          err && typeof err === "object" && "data" in err
            ? (err as { data: unknown }).data
            : undefined,
      };
    }
  }, memberId);
}

/** Complete mandatory Circle setup (CS-5); lands on the Circle dashboard. */
export async function finishCircleSetup(page: Page) {
  await page.getByRole("button", { name: "Finish setup" }).click();
  await page.waitForURL(/\/circles\/[^/]+-[^/]+$/);
  const setupToast = page.getByText("Circle setup complete.");
  await expect(setupToast).toBeVisible();
  await expect(setupToast).toBeHidden({ timeout: 10_000 });
}

export function circleSwitcher(page: Page) {
  return page.getByRole("button", { name: "Circles", exact: true });
}

export function homeCircleCard(page: Page, name: string | RegExp) {
  return page.getByRole("region", { name: "Your circles" }).getByRole("link", { name });
}

/**
 * Close the Home Circles picker. Multi-select stays open after a choice; Escape
 * dismisses. Don't wait for the listbox to unmount — Base UI can keep it in the
 * tree (opacity-0 still counts as visible to Playwright).
 */
async function dismissHomeScopePicker(page: Page) {
  const listbox = page.getByRole("listbox");
  if (!(await listbox.isVisible())) {
    return;
  }
  await page.keyboard.press("Escape");
  if (!(await listbox.isVisible())) {
    return;
  }
  await page
    .getByRole("button", { name: "Dismiss" })
    .first()
    .click({ force: true, timeout: 5_000 });
}

/** Toggle a Circle in the Home scope multi-select. Included Circles are chips. */
export async function toggleHomeScopeCircle(page: Page, name: string | RegExp) {
  const cashFlow = page.getByRole("region", { name: "Cash flow" });
  const removeName =
    typeof name === "string"
      ? new RegExp(`^Remove ${escapeRegExp(name)}$`)
      : new RegExp(`^Remove ${name.source}$`, name.flags);
  const remove = cashFlow.getByRole("button", { name: removeName });
  if (await remove.isVisible()) {
    await remove.click({ timeout: 10_000 });
    await expect(remove).toHaveCount(0, { timeout: 15_000 });
    await dismissHomeScopePicker(page);
    return;
  }
  await dismissHomeScopePicker(page);
  await cashFlow.getByRole("combobox", { name: "Circles" }).click({ timeout: 10_000 });
  const option = page.getByRole("option", { name });
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click({ timeout: 10_000 });
  await expect(option).toHaveAttribute("aria-selected", "true");
  await dismissHomeScopePicker(page);
  await expect(remove).toBeVisible({ timeout: 15_000 });
}

/** Open the worker's Personal Circle from Home navigation cards (not Cash flow rows). */
export async function openPersonalCircleFromHome(page: Page) {
  await page.goto("/");
  await homeCircleCard(page, /Your Circle/).click();
}

/**
 * Shell → create regular Circle → mandatory setup complete → dashboard.
 * Use for specs that need an isolated Circle without polluting Personal pickers.
 */
export async function createRegularCircleAndFinishSetup(
  page: Page,
  { name, color, currency }: { name: string; color?: string; currency?: string },
) {
  await page.goto("/circles/new");
  await page.getByLabel("Name").fill(name);
  if (currency) {
    await page.getByLabel("Currency").selectOption(currency);
  }
  if (color) {
    await page.getByRole("button", { name: color }).click();
  }
  await page.getByRole("button", { name: "Create circle" }).click();
  await finishCircleSetup(page);
}

/**
 * Owner invites `memberEmail` via the Members form, waits for the server-driven
 * success status, then reads the emailed token from the E2E-only backend stash.
 * Requires the owner page to already be authenticated on a setup-complete regular Circle.
 */
export async function inviteMemberByEmail(page: Page, memberEmail: string): Promise<string> {
  await clickCircleChromeTab(page, "Members");
  const form = page.getByRole("form", { name: "Invite member" });
  await form.getByLabel("Email address").fill(memberEmail);
  await form.getByRole("button", { name: "Invite member" }).click();
  await expect(form.getByRole("status")).toHaveText(
    new RegExp(`Invitation sent to ${escapeRegExp(memberEmail)}`, "i"),
  );
  return invokeScE2E<string>(page, "getInvitationToken", [memberEmail]);
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True-E2E does not run MSW. Block PostHog at the context so a leaked key cannot escape. */
export async function installVendorFirewall(context: BrowserContext) {
  await context.route(/posthog\.com/i, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' }),
  );
}

export async function createIsolatedBrowserContext(
  browser: Browser,
  options?: Parameters<Browser["newContext"]>[0],
) {
  const context = await browser.newContext(options);
  await installVendorFirewall(context);
  return context;
}

/**
 * Extra browser session for a second User: inherits the active project's device
 * settings (desktop-chromium vs mobile-chromium viewport/UA) but not the
 * per-worker `storageState` — pair with `establishE2ESession` on `newPage()`.
 */
export function createSecondaryBrowserContext(browser: Browser, testInfo: TestInfo) {
  return createIsolatedBrowserContext(browser, testInfo.project.use);
}

/** Signs in a second User and accepts an invitation via the E2E-only backend helper. */
export async function joinCircleViaInvitation(opts: {
  browser: Browser;
  baseURL: string;
  memberEmail: string;
  memberName: string;
  token: string;
}) {
  const context = await createIsolatedBrowserContext(opts.browser);
  const page = await context.newPage();
  try {
    await establishE2ESession(page, {
      baseURL: opts.baseURL,
      email: opts.memberEmail,
      name: opts.memberName,
    });
    await page.evaluate(async (token) => {
      const helper = Reflect.get(globalThis, "__scE2E");
      if (typeof helper !== "object" || helper === null) {
        throw new Error("missing __scE2E");
      }
      const acceptInvitation = Reflect.get(helper, "acceptInvitation");
      if (typeof acceptInvitation !== "function") {
        throw new Error("missing acceptInvitation");
      }
      await Reflect.apply(acceptInvitation, helper, [token]);
    }, opts.token);
    return { context, page };
  } catch (err) {
    await context.close();
    throw err;
  }
}

/** Phase-1 route skeleton (issue #121) swaps the outlet; wait for it to clear before interacting. */
async function waitForCircleRouteReady(page: Page) {
  await expect(page.getByTestId("route-skeleton")).toHaveCount(0);
}

/**
 * Circle tab navigation: desktop horizontal tabs vs mobile bottom bar + More sheet
 * (issue #124). Use instead of bare `getByRole("link", { name: … })` for Circle chrome.
 */
export async function clickCircleChromeTab(page: Page, tab: CircleChromeTab) {
  const width = page.viewportSize()?.width ?? SM_BREAKPOINT_PX;
  if (width >= SM_BREAKPOINT_PX) {
    await page
      .getByRole("navigation", { name: "Circle tabs" })
      .getByRole("link", { name: tab, exact: true })
      .click();
    await waitForCircleRouteReady(page);
    return;
  }
  if (tab === "Dashboard" || tab === "Transactions" || tab === "Search") {
    await page
      .getByRole("navigation", { name: "Circle" })
      .getByRole("link", { name: tab, exact: true })
      .click();
    await waitForCircleRouteReady(page);
    return;
  }
  await page
    .getByRole("navigation", { name: "Circle" })
    .getByRole("button", { name: "More" })
    .click();
  await page
    .getByRole("dialog", { name: "More" })
    .getByRole("link", { name: tab, exact: true })
    .click();
  await waitForCircleRouteReady(page);
}

/** Ledger list finished its reactive fetch (filter/month changes show transactions-skeleton). */
export async function waitForTransactionsLedgerReady(page: Page) {
  await expect(page.getByTestId("transactions-skeleton")).toHaveCount(0);
}

/** Ledger Transactions filter: Active vs Archived status. */
export async function applyLedgerStatus(page: Page, status: "active" | "archived") {
  await page.getByRole("button", { name: /Filters/ }).click();
  const dialog = page.getByRole("dialog", { name: "Filters" });
  await dialog.getByRole("button", { name: status === "active" ? "Active" : "Archived" }).click();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await waitForTransactionsLedgerReady(page);
}

/**
 * After a blocked write attempt, assert a Transaction row never lands on the ledger.
 * Waits for the list query to settle, then polls so a late reactive insert can't slip through.
 */
export async function assertLedgerRowStaysAbsent(
  page: Page,
  titleText: string,
  { stableMs = 2_000, intervalMs = 200 } = {},
) {
  const row = page.getByRole("listitem").filter({ hasText: titleText });
  await waitForTransactionsLedgerReady(page);
  await expect(row).toHaveCount(0);

  const deadline = Date.now() + stableMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(intervalMs);
    await expect(row).toHaveCount(0);
  }
}

/**
 * Issue #207: destructive archive is a two-step confirm (arm → confirm within 10s).
 * `scope` is the page or a row locator that contains the archive button.
 */
export async function armArchive(scope: Page | Locator, itemName: string) {
  await scope.getByRole("button", { name: `Archive ${itemName}` }).click();
}

export async function confirmArchive(scope: Page | Locator, itemName: string) {
  await scope.getByRole("button", { name: `Confirm archive ${itemName}` }).click();
}

export async function archiveWithDoubleCheck(scope: Page | Locator, itemName: string) {
  await armArchive(scope, itemName);
  await confirmArchive(scope, itemName);
}

/**
 * Pick from a "Categories" combobox inside `scope` (a form or filter dialog).
 * Base UI portals options to `body`; never scope the option lookup to `scope`.
 */
export async function pickFormCategory(page: Page, scope: Locator, name: string) {
  await scope.getByRole("combobox", { name: "Categories" }).click();
  await page.getByRole("option", { name }).click();
  await page.keyboard.press("Escape");
}

/**
 * Inline-create a Category in a Transaction form combobox (CAT-3).
 */
export async function inlineCreateFormCategory(page: Page, scope: Locator, name: string) {
  const combo = scope.getByRole("combobox", { name: "Categories" });
  await combo.click();
  await combo.fill(name);
  await page.getByRole("option", { name: `Create "${name}"` }).click();
  // createCategory is async; wait for the chip. Don't Escape — it can clear the selection.
  await expect(scope.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
}

/**
 * Create a Category through the dedicated new-Category route (issue #96; revised #138):
 * from the Categories list, the "New category" CTA opens the create page, submit creates it
 * and navigates back to the list (its `returnTo`). The form now carries an in-form
 * Expense/Income toggle (not a list tab), so this opens the create page directly and flips
 * the toggle to Income when needed. The caller asserts the resulting row if it needs to —
 * kept out of here so pagination-sensitive specs don't wait on a row that may land on a
 * later page. Assumes the Categories surface is already showing.
 */
export async function createCategoryViaForm(
  page: Page,
  { name, type = "expense", color }: { name: string; type?: "expense" | "income"; color?: string },
) {
  await page.getByRole("link", { name: "New category" }).click();
  // Scope EVERY interaction to the create form (its `aria-label` landmark). The list and
  // the form both expose a `Type` group with an Expense/Income toggle, so an unscoped
  // locator can hit the list filter while React Router is still committing the `/new`
  // route. Resolving through the form locator auto-waits for the form to mount first.
  const form = page.getByRole("form", { name: "New category" });
  if (type === "income") {
    await form.getByRole("group", { name: "Type" }).getByRole("button", { name: "Income" }).click();
  }
  await form.getByLabel(new RegExp(`New ${type} category`)).fill(name);
  if (color) {
    await form.getByRole("button", { name: color }).click();
  }
  await form.getByRole("button", { name: "Add category" }).click();
  // Success navigates back to the categories list (returnTo); the page leaves `/new`.
  await page.waitForURL(/\/categories(?:\?|$)/);
}

const e2eDir = dirname(fileURLToPath(import.meta.url));

const E2E_PASSWORD = "e2e-Password-123";

/** USR-1: fresh sign-ups gate on `/onboarding` until Display Name is confirmed. */
async function ensureAppShellReady(page: Page) {
  // `Home` is the signed-in h1 (visible during Home Summary loading). `Your circles`
  // is now a section heading behind getHomeSummary — waiting on it stalls shell-ready.
  const homeHeading = page.getByRole("heading", { name: "Home", exact: true });
  const continueButton = page.getByRole("button", { name: "Continue" });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await homeHeading.isVisible()) {
      return;
    }
    if (await continueButton.isVisible()) {
      await continueButton.click();
      await homeHeading.waitFor({ timeout: 30_000 });
      return;
    }
    await page.waitForTimeout(250);
  }

  await homeHeading.waitFor({ timeout: 0 });
}

/**
 * Drive the flag-gated email+password test-auth bypass (ADR 0019) on `page` until it
 * lands authenticated on the app shell. Signs up (first run for a unique email) then
 * signs in via `window.__scE2E`, leaving a REAL Better Auth session in the page's
 * context — exactly what the per-worker fixture below captures as `storageState`, and
 * what the sign-out spec drives directly in a throwaway context so it can revoke a
 * session without clobbering the worker's shared one.
 */
export async function establishE2ESession(
  page: Page,
  opts: { baseURL: string; email: string; password?: string; name?: string },
) {
  const password = opts.password ?? E2E_PASSWORD;
  const name = opts.name ?? "E2E Tester";

  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(opts.baseURL, { waitUntil: "domcontentloaded" });
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      await page.waitForTimeout(1000);
    }
  }

  await waitForScE2E(page);

  let signInResult: string | undefined;
  try {
    signInResult = await page.evaluate(
      async ([e, p, n]) => {
        const helper = Reflect.get(globalThis, "__scE2E");
        if (typeof helper !== "object" || helper === null) {
          return "error: missing __scE2E";
        }
        const signIn = Reflect.get(helper, "signIn");
        if (typeof signIn !== "function") {
          return "error: bad signIn";
        }
        try {
          await Reflect.apply(signIn, helper, [e, p, n]);
          return "ok";
        } catch (err) {
          return `error: ${String(err instanceof Error ? err.message : err)}`;
        }
      },
      [opts.email, password, name],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Better Auth can reload mid-sign-in; awaiting the in-page promise then loses
    // the realm → Playwright throws here. Continue: locator wait below survives nav.
    if (!msg.includes("Execution context was destroyed")) {
      throw err;
    }
  }
  if (signInResult !== undefined && signInResult !== "ok") {
    throw new Error(`E2E sign-in failed: ${signInResult}`);
  }

  await page.goto(opts.baseURL, { waitUntil: "domcontentloaded" });
  await ensureAppShellReady(page);
}

async function signUpUserAndSaveStorageState(opts: {
  baseURL: string;
  workerIndex: number;
  browser: Browser;
}) {
  const email = `e2e+w${opts.workerIndex}-${Date.now()}@example.com`;
  const storagePath = join(e2eDir, ".auth", `worker-${opts.workerIndex}.json`);

  const context = await createIsolatedBrowserContext(opts.browser);
  const page = await context.newPage();
  try {
    await establishE2ESession(page, { baseURL: opts.baseURL, email });
    await mkdir(dirname(storagePath), { recursive: true });
    await page.context().storageState({ path: storagePath });
    return storagePath;
  } finally {
    await context.close();
  }
}

/**
 * One Better Auth session per Playwright worker (ADR 0019). Each worker gets its
 * own User + Personal Circle so parallel desktop/mobile projects cannot clobber
 * each other's list/total assertions.
 */
export const test = base.extend<object, { workerStorageState: string }>({
  context: async ({ context }, use) => {
    await installVendorFirewall(context);
    await use(context);
  },

  storageState: async ({ workerStorageState }, use) => {
    await use(workerStorageState);
  },

  workerStorageState: [
    async ({ browser }, use, workerInfo) => {
      const raw = workerInfo.project.use.baseURL;
      const resolvedBase =
        typeof raw === "string" && raw.length > 0 ? raw : "http://127.0.0.1:5173";
      const pathToState = await signUpUserAndSaveStorageState({
        baseURL: resolvedBase,
        workerIndex: workerInfo.workerIndex,
        browser,
      });
      await use(pathToState);
    },
    // Cold Convex + 5 parallel worker sign-ups can exceed default 30s fixture budget.
    { scope: "worker", timeout: 120_000 },
  ],
});

/**
 * Headline totals use NumberFlow (`AnimatedMoney`). Digit strips live in open
 * shadow DOM, so parent `toContainText` sees `$0123456789…` — assert the
 * accessible name / `data-money` contract instead.
 *
 * A scope can contain multiple matching amounts (e.g. empty month → three `$0.00`
 * cards); presence asserts the first match is visible.
 */
export function headlineMoney(scope: Locator, amount: string) {
  return scope.locator(`[data-money=${JSON.stringify(amount)}]`);
}

export async function expectHeadlineMoney(scope: Locator, amount: string) {
  await expect(headlineMoney(scope, amount).first()).toBeVisible();
}

export { expect };
