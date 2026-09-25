import type { Page } from "@playwright/test";
import {
  appBaseUrl,
  createIsolatedBrowserContext,
  createRegularCircleAndFinishSetup,
  establishE2ESession,
  expect,
  inviteMemberByEmail,
  invokeScE2E,
  openHome,
  test,
} from "./fixtures.js";
import {
  clickPushNotification,
  createPushE2EBrowserContext,
  deliverSimulatedPush,
  waitForPushNotification,
} from "./push-helpers.js";

/**
 * TRUE-E2E Web Push path (#385 / ADR 0033): announcement enable → subscribe via
 * production push-sw.js → simulated push-service delivery → visible SW
 * notification → click → authenticated resolve → Notification Center read.
 *
 * Headed persistent Chromium (not Incognito — Push API unavailable there).
 * External push-service subscribe may use synthetic endpoint material when
 * FCM rejects automation; SW display + click + app routing stay real. Delivery
 * payload is the production wire object from the backend
 * (`buildVisiblePushPayload`), not hand-built title/body strings.
 *
 * Platform smoke outside Chromium: docs/research/web-push-platform-smoke.md.
 */

test.use({ headless: false });

const STRIP_TITLE = /Enable notifications on this device/i;

type PushWirePayload = { title: string; body: string; tag: string };

function isPushWirePayload(value: unknown): value is PushWirePayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag" in value &&
    "title" in value &&
    "body" in value &&
    typeof value.tag === "string" &&
    value.tag.length > 0 &&
    typeof value.title === "string" &&
    typeof value.body === "string"
  );
}

async function pollLatestUnreadPushDeliveryPayload(page: Page) {
  let payload: PushWirePayload | null = null;
  await expect
    .poll(
      async () => {
        const next = await invokeScE2E<unknown>(
          page,
          "getLatestUnreadPushDeliveryPayload",
          [],
          "helper",
        );
        if (isPushWirePayload(next)) {
          payload = next;
          return true;
        }
        return false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  if (!payload) {
    throw new Error("Push E2E: unread push delivery payload never appeared");
  }
  return payload;
}

async function readNotificationReadState(page: Page, notificationId: string) {
  return invokeScE2E<boolean | null>(page, "getNotificationRead", [notificationId], "helper");
}

async function countBoundPushSubscriptions(page: Page) {
  return invokeScE2E<number>(page, "countPushSubscriptions", [], "helper");
}

async function expectLocalAndBoundSubscription(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration("/push-sw.js");
        return Boolean(reg?.active && (await reg.pushManager.getSubscription()));
      }),
    )
    .toBe(true);
  await expect.poll(() => countBoundPushSubscriptions(page)).toBeGreaterThan(0);
}

test("Push: announcement enable → simulated delivery → click resolves and marks read", async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const resolvedBase = appBaseUrl(baseURL);
  const stamp = `${Date.now()}-${testInfo.project.name}`;
  const inviteeEmail = `e2e+push-invitee-${stamp}@example.com`;
  const ownerEmail = `e2e+push-owner-${stamp}@example.com`;
  const circleName = `Push Circle ${stamp}`;

  const inviteeContext = await createPushE2EBrowserContext(testInfo.project.use);
  const inviteePage = await inviteeContext.newPage();

  try {
    await establishE2ESession(inviteePage, {
      baseURL: resolvedBase,
      email: inviteeEmail,
      name: "Push Invitee",
    });

    await openHome(inviteePage);
    const strip = inviteePage.getByTestId("notification-announcement-strip");
    await expect(strip).toBeVisible({ timeout: 30_000 });
    await expect(strip.getByRole("heading", { name: STRIP_TITLE })).toBeVisible();
    await strip.getByRole("button", { name: "Enable notifications" }).click();

    // Success and failure both dismiss the strip — assert the success toast + bind.
    await expect(inviteePage.getByText("Notifications enabled on this device.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(inviteePage.getByTestId("notification-announcement-strip")).toHaveCount(0);
    await expectLocalAndBoundSubscription(inviteePage);

    const ownerContext = await createIsolatedBrowserContext(browser, testInfo.project.use);
    const ownerPage = await ownerContext.newPage();
    try {
      await establishE2ESession(ownerPage, {
        baseURL: resolvedBase,
        email: ownerEmail,
        name: "Push Owner",
      });
      await createRegularCircleAndFinishSetup(ownerPage, { name: circleName });
      await inviteMemberByEmail(ownerPage, inviteeEmail);
    } finally {
      await ownerContext.close();
    }

    const pushPayload = await pollLatestUnreadPushDeliveryPayload(inviteePage);
    await expect(readNotificationReadState(inviteePage, pushPayload.tag)).resolves.toBe(false);

    await deliverSimulatedPush(inviteePage, pushPayload);
    await waitForPushNotification(inviteePage, pushPayload);

    await Promise.all([
      inviteePage.waitForURL(/\/(from-notification|invitations)\//, { timeout: 30_000 }),
      clickPushNotification(inviteeContext, pushPayload.tag),
    ]);

    await expect(inviteePage).toHaveURL(/\/invitations\/[^/?#]+/);
    await expect
      .poll(() => readNotificationReadState(inviteePage, pushPayload.tag), { timeout: 30_000 })
      .toBe(true);
  } finally {
    await inviteeContext.close();
  }
});

test("Push: Settings enable subscribes when announcement already dismissed", async ({
  baseURL,
}, testInfo) => {
  const resolvedBase = appBaseUrl(baseURL);
  const stamp = `${Date.now()}-${testInfo.project.name}-settings`;
  const context = await createPushE2EBrowserContext(testInfo.project.use);
  const page = await context.newPage();
  try {
    await establishE2ESession(page, {
      baseURL: resolvedBase,
      email: `e2e+push-settings-${stamp}@example.com`,
      name: "Push Settings",
    });

    await openHome(page);
    const strip = page.getByTestId("notification-announcement-strip");
    await expect(strip).toBeVisible({ timeout: 30_000 });
    await strip.getByRole("button", { name: "Dismiss notification announcement" }).click();
    await expect(page.getByTestId("notification-announcement-strip")).toHaveCount(0);

    await page.goto(`${resolvedBase}/settings`);
    const enableSwitch = page.getByRole("switch", {
      name: /Enable notifications on this device/i,
    });
    await expect(enableSwitch).toBeVisible({ timeout: 30_000 });
    await expect(enableSwitch).toHaveAttribute("aria-checked", "false");
    await enableSwitch.click();
    await expect(page.getByText("Notifications enabled on this device.")).toBeVisible();
    await expect(enableSwitch).toHaveAttribute("aria-checked", "true");
    await expectLocalAndBoundSubscription(page);
  } finally {
    await context.close();
  }
});
