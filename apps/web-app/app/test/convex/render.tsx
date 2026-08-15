import { act, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from "react-router";
import { PwaInstallProvider } from "~/components/pwa-install.js";
import type { Circle } from "~/lib/data.js";
import { SnackbarProvider } from "~/lib/snackbar.js";
import type { CircleOutletContext } from "~/routes/layouts/circle-layout.js";

function withRouter(node: ReactElement, initialEntries?: string[]) {
  return <MemoryRouter initialEntries={initialEntries}>{node}</MemoryRouter>;
}

/** Renders a route that reads no Circle context (e.g. Home) under a real router. */
export function renderWithRouter(element: ReactElement) {
  return render(withRouter(element));
}

/** Renders a Circle-scoped route with the Circle supplied through a REAL Outlet
 * context — the same channel the Circle guard layout uses — so the real `useCircle`
 * runs. `rerenderInCircle` rebuilds a fresh element tree so React reconciles (re-
 * reading the query doubles) rather than bailing on an identical element; pass a
 * `nextCircle` to model the reactive `getCircle` flipping (e.g. the Circle archived
 * mid-edit), defaulting to the originally-rendered Circle. `initialEntries` seeds the
 * address bar so a route reading the current URL (e.g. the Dashboard building a
 * `returnTo` from its own location) sees a realistic path under the `*` match. */
export function renderInCircle(
  circle: Circle,
  element: ReactElement,
  opts: { initialEntries?: string[] } = {},
) {
  const wrap = (node: ReactElement, current: Circle) =>
    withRouter(
      <Routes>
        <Route element={<Outlet context={{ circle: current } satisfies CircleOutletContext} />}>
          <Route path="*" element={node} />
        </Route>
      </Routes>,
      opts.initialEntries,
    );
  const result = render(wrap(element, circle));
  return {
    ...result,
    rerenderInCircle: (node: ReactElement, nextCircle: Circle = circle) =>
      result.rerender(wrap(node, nextCircle)),
  };
}

/** Surfaces the live URL (pathname + search) so URL-state tests can assert it. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function NavigationProbe({
  onNavigate,
}: {
  onNavigate: (navigate: ReturnType<typeof useNavigate>) => void;
}) {
  const navigate = useNavigate();
  onNavigate(navigate);
  return null;
}

/** Minimal Circle-layout `<h1>` chrome for heading-hierarchy assertions in route tests. */
export function circleLayoutHeadingChrome(circle: Pick<Circle, "name">) {
  return <h1>{circle.name}</h1>;
}

/**
 * Renders arbitrary (non-Circle-scoped) ROUTES under a real `MemoryRouter` so route
 * navigation is exercised end to end: the test seeds the address bar via `initialEntries`,
 * reads it back through {@link LocationProbe} (`location()`), and real route logic,
 * `useNavigate`, and `useSnackbar` all run. Used by the shell surfaces that live ABOVE
 * the Circle guard (the Circle switcher, the Create Circle flow — CS-0), which resolve no
 * Circle from context. `SnackbarProvider` wraps so a route's snackbar has its real context.
 *
 * `routes` is the caller's `<Route>` subtree, kept generic so this helper never imports
 * route modules — the test wires only the routes it needs (typically the surface under
 * test plus a probe route the flow navigates to).
 */
export function renderRoutes(routes: ReactNode, opts: { initialEntries?: string[] } = {}) {
  let navigate: ReturnType<typeof useNavigate> | undefined;
  const result = render(
    <PwaInstallProvider>
      <SnackbarProvider>
        <MemoryRouter initialEntries={opts.initialEntries ?? ["/"]}>
          <LocationProbe />
          <NavigationProbe
            onNavigate={(nextNavigate) => {
              navigate = nextNavigate;
            }}
          />
          <Routes>{routes}</Routes>
        </MemoryRouter>
      </SnackbarProvider>
    </PwaInstallProvider>,
  );
  return {
    ...result,
    /** The current URL (pathname + search), e.g. `/circles/my-home-c1`. */
    location: () => result.getByTestId("location").textContent ?? "",
    navigate: (to: string) => {
      if (navigate == null) {
        throw new Error("Router navigate function unavailable.");
      }
      const currentNavigate = navigate;
      return act(() => currentNavigate(to));
    },
  };
}

/**
 * Renders Circle-scoped ROUTES under a real `MemoryRouter` so URL-owned state (the
 * ledger `month`, the `new` create param, and the edit object route — TXN-5/ADR 0017)
 * is exercised end to end: the test seeds the address bar via `initialEntries`, reads
 * it back through {@link LocationProbe} (`location()`), and the real route logic,
 * `useSearchParams`, `useResolvedTransaction`, and `useSnackbar` all run. The Circle is
 * supplied through the same Outlet context channel the Circle guard uses, so the real
 * `useCircle` runs; `rerender(nextCircle)` models the reactive `getCircle` flipping
 * (e.g. archived mid-edit). `SnackbarProvider` wraps so the unavailable-link fallback
 * has its real context.
 *
 * `routes` is the caller's `<Route>` subtree (the routes under test), kept generic so
 * this helper never imports route modules — the test wires only the routes it needs.
 * `chrome` is an optional always-mounted node rendered inside the Router but outside
 * `Routes` (so it has router context and survives route changes) — e.g. a nav control a
 * test uses to drive an in-route param change (edit→edit) without unmounting the route.
 */
export function renderCircleRoutes(
  circle: Circle,
  routes: ReactNode,
  opts: { initialEntries?: string[]; chrome?: ReactNode } = {},
) {
  const wrap = (current: Circle) => (
    <PwaInstallProvider>
      <SnackbarProvider>
        <MemoryRouter initialEntries={opts.initialEntries ?? ["/"]}>
          <LocationProbe />
          {opts.chrome}
          <Routes>
            <Route element={<Outlet context={{ circle: current } satisfies CircleOutletContext} />}>
              {routes}
            </Route>
          </Routes>
        </MemoryRouter>
      </SnackbarProvider>
    </PwaInstallProvider>
  );
  const result = render(wrap(circle));
  return {
    ...result,
    rerender: (nextCircle: Circle = circle) => result.rerender(wrap(nextCircle)),
    /** The current URL (pathname + search), e.g. `/circles/trip-c1/transactions?month=2026-05`. */
    location: () => result.getByTestId("location").textContent ?? "",
  };
}
