/**
 * Production Push service worker (#381 subscription lifecycle only).
 * No fetch handler, cache, or offline shell. Push display / click → #382 / #384.
 */
self.addEventListener("pushsubscriptionchange", () => {
  // Page reconcile on focus/startup rebinds; no endpoint material here.
});
