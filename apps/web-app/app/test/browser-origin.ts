import { APP_ORIGIN } from "@pocketcircle/domain";
import { vi } from "vitest";

/**
 * Pins the origin `window.location` reports, for tests that assert on a URL the app
 * builds from it — Better Auth's sign-in callback is resolved against the browser's
 * own origin (#409), so the expectation has to name one. jsdom's default
 * `http://localhost:3000` is not an origin this app is ever served from, which would
 * let a test pass without saying anything about the real thing.
 *
 * The default is the **app** origin, because that is the origin the app is served
 * from (ADR 0035). The apex is the marketing Site's and never runs this app, so a
 * test that reaches for the default is asserting against a host it would never be
 * served from. Pass an origin explicitly to pin a different one.
 *
 * Pair with {@link restoreBrowserOrigin} in `afterEach`.
 */
export function pinBrowserOrigin(path = "/", origin: string = APP_ORIGIN) {
  vi.stubGlobal("location", new URL(path, origin));
}

export function restoreBrowserOrigin() {
  vi.unstubAllGlobals();
}
