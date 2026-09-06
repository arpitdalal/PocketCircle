import { GoogleSignInPanel } from "~/components/google-sign-in-panel.js";

/**
 * Temporary signed-out homepage at `/` for Google OAuth branding checks and
 * first-time visitors. Not the long-term marketing site; keep copy short and
 * factual so the consent-screen homepage URL is not a login-only shell.
 * Continues with Google in one click (same controls as `/signin`).
 */
export function MarketingHome() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-background px-4 pt-(--safe-area-top) pb-(--safe-area-bottom)">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 size-144 -translate-x-1/2 rounded-full bg-primary/15 blur-3xl"
      />
      <main className="relative mx-auto w-full max-w-lg space-y-8 text-center">
        <div className="space-y-4">
          <CircleGlyph />
          <div className="space-y-3">
            <h1 className="font-display text-4xl font-semibold tracking-tight">PocketCircle</h1>
            <p className="text-base text-muted-foreground">
              PocketCircle helps you track spending together in shared Circles. Record expenses and
              income, organize Categories, and review totals with others.
            </p>
          </div>
        </div>

        <GoogleSignInPanel buttonClassName="min-w-48" />
      </main>
    </div>
  );
}

function CircleGlyph() {
  return (
    <span
      aria-hidden
      className="mx-auto flex size-16 items-center justify-center rounded-full border-2 border-primary/20"
    >
      <span className="flex size-11 items-center justify-center rounded-full border-2 border-primary/45">
        <span className="size-5 rounded-full bg-primary" />
      </span>
    </span>
  );
}
