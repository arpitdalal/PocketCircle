import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root.js";
import stylesheet from "./app.css?url";
import { MarketingHome } from "./components/marketing-home.js";
import { AppProviders } from "./providers.js";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover unlocks env(safe-area-inset-*); without it insets are 0
            and edge-to-edge PWAs leave a dead gap under the bottom bar. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0d0b13" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <title>PocketCircle</title>
        <meta
          name="description"
          content="PocketCircle helps you track spending together in shared Circles. Record expenses and income, organize Categories, and review totals with others."
        />
        <link rel="icon" href="/favicon.ico" sizes="48x48" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <link rel="stylesheet" href={stylesheet} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <AppProviders>
      <Outlet />
    </AppProviders>
  );
}

/**
 * Baked into SPA `index.html` at build time. Google branding crawlers (no JS)
 * must see PocketCircle, purpose copy, and Privacy/Terms links here. Same UI as
 * signed-out `/` after hydrate. Deep-link fallbacks briefly show this shell
 * then client-route (same flash pattern as the old Splash shell).
 */
export function HydrateFallback() {
  return <MarketingHome />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div className="flex min-h-dvh items-center justify-center p-6 text-center">
      <div className="max-w-md space-y-2">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
