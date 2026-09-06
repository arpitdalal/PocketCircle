import { Navigate, useSearchParams } from "react-router";
import { GoogleSignInPanel } from "~/components/google-sign-in-panel.js";
import { Splash } from "~/components/splash.js";
import { parseReturnTo, RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import { useAppSession } from "~/lib/session.js";

/**
 * Sign-in route guard: an already-authenticated visitor has no use for the form,
 * so bounce them to the return target (or app root) and let ProtectedLayout route
 * on the resolved state (ready → target, bootstrap → /onboarding) — the inverse of
 * the layout's unauthenticated → /signin redirect. Splash while auth is still
 * resolving so an authenticated reload never flashes the form before redirecting.
 */
export default function SignIn() {
  const session = useAppSession();
  const [searchParams] = useSearchParams();
  const returnTo = parseReturnTo(searchParams.get(RETURN_TO_PARAM), { fallback: "/" });

  if (session.state === "loading") {
    return <Splash />;
  }
  if (session.state !== "unauthenticated") {
    return <Navigate to={returnTo} replace />;
  }
  return <SignInForm returnTo={returnTo} />;
}

/**
 * Sign-in wrap (ADR 0014): conspicuous copy ties account creation to the Terms
 * and Privacy Policy, with no separate checkbox. Google is the only provider.
 */
function SignInForm({ returnTo }: { returnTo: string }) {
  return (
    <div className="space-y-8 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
      <div className="space-y-4">
        <CircleGlyph />
        <div className="space-y-2">
          <h1 className="font-display text-3xl font-semibold tracking-tight">PocketCircle</h1>
          <p className="text-sm text-muted-foreground">Track money together in shared circles.</p>
        </div>
      </div>

      <GoogleSignInPanel returnTo={returnTo} />
    </div>
  );
}

/** The circle motif at hero size: concentric iris rings around a solid core. */
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
