import { index, layout, prefix, type RouteConfig, route } from "@react-router/dev/routes";

/**
 * Config-based routes (ADR 0017) — chosen over file-based routing because
 * file-name conventions fight the `slug-id` refs and Circle-scoped nesting of
 * ADR 0016. The tree splits on authentication: a public layout and a protected
 * layout that gates on reactive Convex auth across three states.
 */
export default [
  // Public surfaces. The protected layout never wraps these.
  layout("routes/layouts/public-layout.tsx", [
    layout("routes/layouts/public-narrow-layout.tsx", [
      route("signin", "routes/signin.tsx"),
      // Opaque, token-only Invitation landing — the ADR 0016 exception.
      route("invite/:token", "routes/invite.tsx"),
      route("delete-account/verify", "routes/delete-account-verify.tsx"),
      route("delete-account/complete", "routes/delete-account-complete.tsx"),
      route("dev/email-preview", "routes/dev/email-preview.tsx"),
    ]),
    layout("routes/layouts/public-reading-layout.tsx", [
      route("terms", "routes/terms.tsx"),
      route("privacy", "routes/privacy.tsx"),
    ]),
  ]),

  // Authenticated app. The protected layout shows a splash while auth resolves,
  // redirects to /signin when unauthenticated, and renders the onboarding branch
  // until the User is bootstrapped and product-onboarded.
  layout("routes/layouts/protected-layout.tsx", [
    index("routes/home.tsx"),
    route("onboarding", "routes/onboarding.tsx"),
    route("settings", "routes/settings.tsx"),
    route("whats-new", "routes/whats-new.tsx"),
    route("feedback", "routes/feedback.tsx"),

    // Circle-scoped routes. The Circle guard resolves/canonicalizes/guards the
    // Circle and provides it to children via Outlet context; object routes
    // resolve their own ref within the resolved Circle (ADR 0016/0017).
    ...prefix("circles", [
      // Create Circle (CS-0). A STATIC segment that takes priority over the dynamic
      // `:circleRef` below, so it never collides with a Circle ref (Circle ids are
      // never the literal "new"). Lives above the Circle guard — it resolves no
      // Circle from context yet.
      route("new", "routes/circle-new.tsx"),
      route(":circleRef", "routes/layouts/circle-layout.tsx", [
        index("routes/circle/dashboard.tsx"),
        route("setup", "routes/circle/setup.tsx"),
        route("transactions", "routes/circle/transactions.tsx"),
        // Create Transaction (issue #96). A STATIC `new` segment that outranks the dynamic
        // `transactions/:transactionRef` below, so it never collides with a Transaction ref
        // (canonical `slug-id` refs are never the literal "new" — ADR 0016), the same
        // reasoning as `circles/new`. A route adapter over the shared Transaction form
        // controller + body (issue #297).
        route("transactions/new", "routes/circle/transaction-new.tsx"),
        route("search", "routes/circle/search.tsx"),
        // The Transaction DETAIL object route (ADR 0016/0017) — the REFERENCE object
        // route: a canonical `slug-id` ref under the resolved Circle, resolving its own
        // target by ID via `useResolvedTransactionDetail` and falling back to the Circle's
        // Transactions route. The read surface for Audit Metadata + Transaction History
        // (TXN-4). Lands WITH its feature — no caller-less placeholder.
        route("transactions/:transactionRef", "routes/circle/transaction-detail.tsx"),
        // The Transaction edit object route (ADR 0016/0017): a canonical `slug-id`
        // ref under the resolved Circle, resolving its own target by ID via
        // `useResolvedTransaction` and falling back to the Circle's Transactions
        // route. Lands WITH its feature (TXN-5) — no caller-less placeholder.
        route("transactions/:transactionRef/edit", "routes/circle/transaction-edit.tsx"),
        route("categories", "routes/circle/categories.tsx"),
        // Create Category (issue #96). Same static-segment pattern: a dedicated page
        // lifts the new-Category form off the list, deep-linked with the active type tab.
        route("categories/new", "routes/circle/category-new.tsx"),
        // The Category DETAIL object route (issue #240, ADR 0016/0017) — the Category
        // sibling of Transaction Detail: canonical `slug-id` ref under the resolved
        // Circle, resolving its own target by ID via `useResolvedCategoryDetail`.
        route("categories/:categoryRef", "routes/circle/category-detail.tsx"),
        route("members", "routes/circle/members.tsx"),
        route("history", "routes/circle/history.tsx"),
        route("settings", "routes/circle/settings.tsx"),
        route("feedback", "routes/circle/feedback.tsx"),
      ]),
    ]),
  ]),

  // Catch-all splat: same generic, non-revealing fallback; no dedicated 404.
  route("*", "routes/splat.tsx"),
] satisfies RouteConfig;
