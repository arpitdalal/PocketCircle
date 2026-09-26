import { APEX_ORIGIN } from "@pocketcircle/domain";
import { vi } from "vitest";

/**
 * Pins the origin `window.location` reports, for tests that assert on a URL the app
 * builds from it — Better Auth's sign-in callback is resolved against the browser's
 * own origin (#409), so the expectation has to name one. jsdom's default
 * `http://localhost:3000` is not an origin this app is ever served from, which would
 * let a test pass without saying anything about the real thing.
 *
 * Pair with {@link restoreBrowserOrigin} in `afterEach`.
 */
export function pinBrowserOrigin(path = "/", origin: string = APEX_ORIGIN) {
  vi.stubGlobal("location", new URL(path, origin));
}

export function restoreBrowserOrigin() {
  vi.unstubAllGlobals();
}
