# Web Push platform smoke (#385)

Automated Chromium Playwright (`e2e/push-notifications.spec.ts`, project
`desktop-chromium-push`) covers the full path **headed** via
`launchPersistentContext` (Incognito/`newContext` disables the Push API):
announcement or Settings enable → permission → subscribe with production
`push-sw.js` → simulated push delivery into that worker's `push` handler →
visible SW notification → click → authenticated destination resolve →
Notification Center read-state.

Only the external push-service hop is simulated: synthetic
`PushManager.subscribe` endpoint material when FCM rejects automation (narrowed
to push-service errors — not bad VAPID), and a `PushEvent` dispatched into
production `push-sw.js`. Failures fail CI via the existing E2E workflow (fresh
VAPID from `scripts/e2e-generate-vapid.mjs` at deploy time — no committed private
key; headed Chromium runs under `xvfb-run` in CI / Linux local without `DISPLAY`
so SW notifications can surface).

## Not covered by Chromium E2E

Run these on real devices/browsers before calling Push "done" for a release.

### Installed iPhone / iPad web app (iOS/iPadOS 16.4+)

1. Install PocketCircle to Home Screen (Safari Share → Add to Home Screen).
2. Open the **installed** app (not the Safari tab).
3. Enable via announcement strip or Settings → allow the system prompt.
4. Trigger a real Notification Center event from another device/account
   (e.g. invitation).
5. Confirm a visible OS notification while the app is backgrounded.
6. Tap it → land on the live destination → row marked read in Notification Center.
7. Uninstalled Safari tab: confirm strip explains install prerequisite (or is
   suppressed after install-dialog dismiss per #383).

Gaps to record if observed: silent push, missing prompt, click opens Safari
instead of HWA, permission stuck at default.

### Desktop Safari (capable versions)

1. Enable from Settings; confirm native permission.
2. Real or test Push delivery while Safari is in background (and, where
   supported, fully quit).
3. Click → focus/open PocketCircle → resolve + read-state.
4. Note any `clients.navigate` / `openWindow` differences vs Chromium.

### Desktop Firefox

1. Enable from Settings (gesture required; Firefox is strict about that).
2. Confirm subscribe + visible notification on delivery.
3. Click while a PocketCircle tab exists vs none.
4. Note remigration / second-tap behavior if exercising VAPID rotation.

## Verification log

| Surface | Build / date | Verified by | Result | Gaps |
| --- | --- | --- | --- | --- |
| Chromium Playwright headed (`desktop-chromium-push`) | local E2E against self-hosted Convex | automated | green | push-service subscribe + delivery hop simulated; click via open tab (`navigate`), not cold-start `openWindow` |
| Arc (Chromium desktop) | local self-hosted + `pnpm dev` | agent opened `http://127.0.0.1:5173` | app loads; full Push path left for you | use real FCM subscribe (not Playwright shim) |
| Safari desktop | | | | |
| Firefox desktop | | | | |
| iPhone/iPad HWA | | | | |
