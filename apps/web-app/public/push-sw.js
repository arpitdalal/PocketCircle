/**
 * Production Push service worker (#381 lifecycle only).
 * No fetch handler, cache, or offline shell — delivery UX is #382 / #384.
 */
self.addEventListener("push", () => {
  // Placeholder: #382 shows the Notification Center-mirrored payload.
});

self.addEventListener("notificationclick", (event) => {
  // Placeholder: #384 focuses/opens the authenticated destination.
  event.notification.close();
});

self.addEventListener("pushsubscriptionchange", () => {
  // Page reconcile on focus/startup rebinds; no endpoint material here.
});
