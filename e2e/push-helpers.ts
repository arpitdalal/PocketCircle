import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import { expect, installVendorFirewall } from "./fixtures.js";

/**
 * Fixed on-curve Push key material (same as domain test fixtures). Used only when
 * the browser's real PushManager.subscribe cannot reach an external push service
 * under automation — that hop is the simulated boundary (#385).
 */
const E2E_PUSH_P256DH =
  "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const E2E_PUSH_AUTH = "CQkJCQkJCQkJCQkJCQkJCQ";

const SW_WAIT_UNTIL_TIMEOUT_MS = 30_000;

/**
 * Headed Chromium + notification permission + subscribe fallback.
 * Uses `launchPersistentContext` — `browser.newContext` is Incognito-like and
 * Chromium disables the Push API there (crbug / Playwright #23954). Headless
 * cannot surface SW notifications. Real `push-sw.js` still handles push display
 * + click; only the push-service registration hop may fall back to synthetic
 * endpoint material when FCM/Mozilla reject automation.
 */
export async function createPushE2EBrowserContext(
  projectUse: Parameters<typeof chromium.launchPersistentContext>[1],
) {
  const userDataDir = await mkdtemp(join(tmpdir(), "pocketcircle-push-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...projectUse,
    headless: false,
    permissions: ["notifications"],
  });
  await installVendorFirewall(context);
  await installPushServiceSubscribeFallback(context);

  const close = context.close.bind(context);
  context.close = async (options) => {
    try {
      await close(options);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  };

  return context;
}

/** Patch PushManager so enable still binds a Convex row when FCM subscribe fails. */
async function installPushServiceSubscribeFallback(context: BrowserContext) {
  await context.addInitScript(
    ({ p256dh, auth }) => {
      function b64ToBuf(b64: string) {
        const padding = "=".repeat((4 - (b64.length % 4)) % 4);
        const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
        const raw = atob(base64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) {
          out[i] = raw.charCodeAt(i);
        }
        return out.buffer;
      }

      function applicationServerKeyBuffer(
        key: BufferSource | string | null | undefined,
      ): ArrayBuffer | null {
        if (key == null) {
          return null;
        }
        if (typeof key === "string") {
          return b64ToBuf(key);
        }
        if (key instanceof ArrayBuffer) {
          return key;
        }
        const view = ArrayBuffer.isView(key) ? key : null;
        if (!view) {
          return null;
        }
        return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      }

      /** External push-service hop only — Chromium prefixes many failures with
       * "Registration failed - …"; only the push-service wording is simulated. */
      function isPushServiceSubscribeFailure(error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return /push service/i.test(message);
      }

      function createSyntheticSubscription(
        endpoint: string,
        applicationServerKey: ArrayBuffer | null,
      ): PushSubscription {
        const options: PushSubscriptionOptions = {
          userVisibleOnly: true,
          applicationServerKey,
        };
        return {
          endpoint,
          expirationTime: null,
          options,
          getKey(name) {
            if (name === "p256dh") {
              return b64ToBuf(p256dh);
            }
            if (name === "auth") {
              return b64ToBuf(auth);
            }
            return null;
          },
          async unsubscribe() {
            synthetic = null;
            return true;
          },
          toJSON() {
            return {
              endpoint,
              expirationTime: null,
              keys: { p256dh, auth },
            };
          },
        };
      }

      let synthetic: PushSubscription | null = null;
      const origSubscribe = PushManager.prototype.subscribe;
      const origGetSubscription = PushManager.prototype.getSubscription;

      PushManager.prototype.subscribe = async function subscribeWithFallback(options) {
        try {
          const real = await origSubscribe.call(this, options);
          synthetic = null;
          return real;
        } catch (error) {
          if (!isPushServiceSubscribeFailure(error)) {
            throw error;
          }
          const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`;
          synthetic = createSyntheticSubscription(
            endpoint,
            applicationServerKeyBuffer(options?.applicationServerKey),
          );
          return synthetic;
        }
      };

      PushManager.prototype.getSubscription = async function getSubscriptionWithFallback() {
        try {
          const real = await origGetSubscription.call(this);
          if (real) {
            return real;
          }
        } catch {
          // Prefer synthetic when the real probe fails.
        }
        return synthetic;
      };
    },
    { p256dh: E2E_PUSH_P256DH, auth: E2E_PUSH_AUTH },
  );
}

function pushServiceWorker(context: BrowserContext) {
  return context.serviceWorkers().find((sw) => sw.url().includes("/push-sw.js"));
}

/**
 * Simulated external push-service hop (#385). Dispatches a real `push` event
 * into production `push-sw.js`. `payload` must be the production wire object
 * from `buildVisiblePushPayload` / E2E probe — not hand-built copy.
 */
export async function deliverSimulatedPush(
  page: Page,
  payload: { title: string; body: string; tag: string },
) {
  const context = page.context();
  await expect
    .poll(() => Boolean(pushServiceWorker(context)), {
      timeout: 30_000,
    })
    .toBe(true);

  const worker = pushServiceWorker(context);
  if (!worker) {
    throw new Error("Push E2E: push-sw.js worker not registered on context");
  }

  await worker.evaluate(
    async ({ payloadJson, timeoutMs }) => {
      const pending: Array<Promise<unknown>> = [];
      const event = new PushEvent("push", { data: payloadJson });
      const waitUntil = event.waitUntil.bind(event);
      event.waitUntil = (value) => {
        pending.push(Promise.resolve(value));
        return waitUntil(value);
      };
      self.dispatchEvent(event);
      await Promise.race([
        Promise.all(pending),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Push E2E: push waitUntil timed out")), timeoutMs);
        }),
      ]);
    },
    { payloadJson: JSON.stringify(payload), timeoutMs: SW_WAIT_UNTIL_TIMEOUT_MS },
  );
}

/** Visible SW notification matching the production wire payload. */
export async function waitForPushNotification(
  page: Page,
  payload: { title: string; body: string; tag: string },
) {
  await expect
    .poll(
      async () => {
        const notes = await page.evaluate(async (expected) => {
          const registration =
            (await navigator.serviceWorker.getRegistration("/push-sw.js")) ??
            (await navigator.serviceWorker.ready);
          const list = await registration.getNotifications({ tag: expected.tag });
          return list.map((n) => ({ title: n.title, body: n.body, tag: n.tag }));
        }, payload);
        const match = notes.find(
          (n) => n.tag === payload.tag && n.title === payload.title && n.body === payload.body,
        );
        return match ? 1 : 0;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
}

/**
 * Dispatch a real `notificationclick` into production `push-sw.js`, awaiting
 * ExtendableEvent.waitUntil work so navigate can finish.
 *
 * Script-dispatched NotificationEvent is untrusted — `clients.openWindow` may
 * need a real OS click. With an open same-origin tab, production SW uses
 * `WindowClient.navigate` (covered here).
 */
export async function clickPushNotification(context: BrowserContext, tag: string) {
  const worker = pushServiceWorker(context);
  if (!worker) {
    throw new Error("Push E2E: push-sw.js worker not registered on context");
  }

  await worker.evaluate(
    async ({ notificationTag, timeoutMs }) => {
      const notes = await self.registration.getNotifications({ tag: notificationTag });
      const notification = notes[0];
      if (!notification) {
        throw new Error(`Push E2E: no notification for tag ${notificationTag}`);
      }

      const pending: Array<Promise<unknown>> = [];
      const event = new NotificationEvent("notificationclick", {
        notification,
        action: "",
      });
      const waitUntil = event.waitUntil.bind(event);
      event.waitUntil = (value) => {
        pending.push(Promise.resolve(value));
        return waitUntil(value);
      };
      self.dispatchEvent(event);
      await Promise.race([
        Promise.all(pending),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error("Push E2E: notificationclick waitUntil timed out")),
            timeoutMs,
          );
        }),
      ]);
    },
    { notificationTag: tag, timeoutMs: SW_WAIT_UNTIL_TIMEOUT_MS },
  );
}
