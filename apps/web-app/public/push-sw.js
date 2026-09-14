/**
 * Production Push service worker (ADR 0033 / #381 / #382).
 * Push receipt + subscription change only. No fetch handler, cache, or offline
 * shell. Notification click routing → #384.
 *
 * skipWaiting + clients.claim so an updated worker (with the push handler)
 * activates without requiring every controlled tab to close first.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  /** @type {{ title?: string, body?: string, tag?: string }} */
  let payload = {
    title: "PocketCircle",
    body: "Open PocketCircle for details.",
    tag: undefined,
  };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") {
        payload = {
          title: typeof parsed.title === "string" ? parsed.title : payload.title,
          body: typeof parsed.body === "string" ? parsed.body : payload.body,
          tag: typeof parsed.tag === "string" ? parsed.tag : payload.tag,
        };
      }
    }
  } catch {
    // Malformed payload — still show a visible notification (Safari requirement).
  }

  event.waitUntil(
    self.registration
      .showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        data: payload.tag ? { notificationId: payload.tag } : undefined,
      })
      .catch(() =>
        // Display failure must not leave a silent push (Chromium quiet-UI / Safari revoke).
        self.registration.showNotification("PocketCircle", {
          body: "Open PocketCircle for details.",
        }),
      ),
  );
});

self.addEventListener("pushsubscriptionchange", () => {
  // Page reconcile on focus/startup rebinds; no endpoint material here.
});

/** Probed by the page after update/activate — proves display-capable push-sw.js. */
const POCKETCIRCLE_PUSH_SW_VERSION = 1;

self.addEventListener("message", (event) => {
  if (event.data !== "pocketcircle:push-sw-version") {
    return;
  }
  const port = event.ports[0];
  if (!port) {
    return;
  }
  port.postMessage({ version: POCKETCIRCLE_PUSH_SW_VERSION });
});
