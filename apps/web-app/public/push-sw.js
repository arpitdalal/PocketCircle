/**
 * Production Push service worker (ADR 0033 / #381 / #382 / #384).
 * Push receipt, notification click, and subscription change only. No fetch
 * handler, cache, or offline shell.
 *
 * skipWaiting + clients.claim so an updated worker (with the push handler)
 * activates without requiring every controlled tab to close first.
 *
 * Click capability: POCKETCIRCLE_PUSH_SW_VERSION >= 2 (#384).
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

  const notificationData = payload.tag ? { notificationId: payload.tag } : undefined;

  event.waitUntil(
    self.registration
      .showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        // Notification identity only — never a destination URL (#384).
        data: notificationData,
      })
      .catch(() =>
        // Display failure must not leave a silent push (Chromium quiet-UI / Safari revoke).
        // Preserve tag/data so click can still resolve when the outer payload had identity.
        self.registration.showNotification("PocketCircle", {
          body: "Open PocketCircle for details.",
          tag: payload.tag,
          data: notificationData,
        }),
      ),
  );
});

/**
 * Whole-notification tap only (no event-specific action buttons). Closes the OS
 * notification, then focuses an existing same-origin client or opens one.
 * Destination is resolved after auth from Notification identity — never from a
 * payload URL.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const rawId = event.notification.data?.notificationId;
  const fromData = typeof rawId === "string" ? rawId : undefined;
  const fromTag =
    typeof event.notification.tag === "string" && event.notification.tag.length > 0
      ? event.notification.tag
      : undefined;
  const notificationId = parseNotificationId(fromData ?? fromTag);

  event.waitUntil(focusOrOpenPocketCircle(notificationId));
});

self.addEventListener("pushsubscriptionchange", () => {
  // Page reconcile on focus/startup rebinds; no endpoint material here.
});

/**
 * Probed by the page after update/activate — proves display + click-capable
 * push-sw.js (#382 display, #384 click). Bump when click/routing contract changes.
 */
const POCKETCIRCLE_PUSH_SW_VERSION = 2;

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

/** @param {string | undefined} raw */
function parseNotificationId(raw) {
  if (raw == null || raw.length === 0 || raw.length > 128) {
    return undefined;
  }
  if (!/^[a-z0-9]+$/i.test(raw)) {
    return undefined;
  }
  return raw;
}

/**
 * @param {string | undefined} notificationId
 */
async function focusOrOpenPocketCircle(notificationId) {
  const targetPath = notificationId
    ? `/from-notification?n=${encodeURIComponent(notificationId)}`
    : "/";
  const targetUrl = new URL(targetPath, self.location.origin).href;

  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  const sameOrigin = [];
  for (const client of windowClients) {
    try {
      if (new URL(client.url).origin === self.location.origin) {
        sameOrigin.push(client);
      }
    } catch {
      // Ignore opaque / unparsable client URLs.
    }
  }

  // Prefer focused, then visible, else first same-origin window.
  const client =
    sameOrigin.find((c) => c.focused) ??
    sameOrigin.find((c) => c.visibilityState === "visible") ??
    sameOrigin[0];

  if (client) {
    // focus() can reject (WebKit HWA / no transient activation) — must not abort routing.
    try {
      await client.focus();
    } catch {
      // Continue to navigate / postMessage / openWindow.
    }

    if (!notificationId) {
      return;
    }

    let navigated = false;
    if ("navigate" in client && typeof client.navigate === "function") {
      try {
        const navigatedClient = await client.navigate(targetUrl);
        navigated = navigatedClient != null;
      } catch {
        navigated = false;
      }
    }

    if (navigated) {
      return;
    }

    try {
      client.postMessage({
        type: "pocketcircle:push-notification-click",
        notificationId,
      });
      return;
    } catch {
      // Fall through to openWindow when the existing client cannot receive work.
    }
  }

  try {
    const opened = await self.clients.openWindow(targetUrl);
    if (opened) {
      try {
        await opened.focus();
      } catch {
        // Opened but focus rejected — deep-link URL still loaded.
      }
    }
  } catch {
    // openWindow blocked / failed after close — nothing more we can do.
  }
}
