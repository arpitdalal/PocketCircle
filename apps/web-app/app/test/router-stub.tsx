import { render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { AppTestProviders } from "~/test/app-test-providers.js";

/**
 * The "stub + deferred loader" seam for driving the router's PENDING navigation state
 * in component tests (issue #121). The shared `MemoryRouter` render helpers always
 * report `navigation.state === "idle"` (no data router), so they cannot exercise the
 * shell skeleton's `useNavigation()`; `createRoutesStub` builds a real data router that
 * does. Encoded once here (CLAUDE.md) so layout tests state only their route tree.
 */

type StubRoutes = Parameters<typeof createRoutesStub>[0];

/**
 * A promise plus its resolver. Hand `promise` to a route's `loader` to hold that
 * navigation in `"loading"` for as long as the test wants, then call `resolve()` to
 * let the navigation settle.
 *
 * The app itself has NO React Router loaders/actions — in production a navigation sits in
 * `"loading"` purely while the destination route MODULE downloads. There is no API to
 * stall a chunk download on demand, so a deferred loader is the test instrument that
 * reproduces the IDENTICAL observable the layouts react to (`useNavigation().state ===
 * "loading"` with a pending `navigation.location`). The loader-driven path is never hit
 * in prod; only the observable it manufactures is.
 */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<null>((res) => {
    resolve = () => res(null);
  });
  return { promise, resolve };
}

export { AppTestProviders } from "~/test/app-test-providers.js";

/** Renders a `createRoutesStub` route tree under {@link AppTestProviders}, seeding
 * the address bar via `initialEntries`. */
export function renderRouteStub(routes: StubRoutes, initialEntries: string[]) {
  const Stub = createRoutesStub(routes);
  return render(
    <AppTestProviders>
      <Stub initialEntries={initialEntries} />
    </AppTestProviders>,
  );
}
