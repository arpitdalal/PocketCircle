import { LoaderCircle } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Link, Navigate } from "react-router";
import { Splash } from "~/components/splash.js";
import { Button } from "~/components/ui/button.js";
import { type SignInWithGoogleOptions, signInWithGoogle } from "~/lib/auth-client.js";
import {
  getLastUsedGoogleEmail,
  getMaskedLastUsedGoogleEmail,
  subscribeLastUsedGoogleEmail,
} from "~/lib/last-used-google-email.js";
import { useAppSession } from "~/lib/session.js";

/**
 * Sign-in route guard: an already-authenticated visitor has no use for the form,
 * so bounce them to the app root and let ProtectedLayout route on the resolved
 * state (ready → shell, bootstrap → /onboarding) — the inverse of the layout's
 * unauthenticated → /signin redirect. Splash while auth is still resolving so an
 * authenticated reload never flashes the form before redirecting.
 */
export default function SignIn() {
  const session = useAppSession();

  if (session.state === "loading") {
    return <Splash />;
  }
  if (session.state !== "unauthenticated") {
    return <Navigate to="/" replace />;
  }
  return <SignInForm />;
}

/**
 * Sign-in wrap (ADR 0014): conspicuous copy ties account creation to the Terms
 * and Privacy Policy, with no separate checkbox. Google is the only provider.
 */
function SignInForm() {
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maskedEmail = useSyncExternalStore(
    subscribeLastUsedGoogleEmail,
    getMaskedLastUsedGoogleEmail,
    () => null,
  );
  const showLastUsedHint = maskedEmail !== null;

  const startGoogleSignIn = async (options: SignInWithGoogleOptions = {}) => {
    if (isSigningIn) {
      return;
    }

    setError(null);
    setIsSigningIn(true);

    try {
      await signInWithGoogle("/", options);
    } catch {
      setError("Couldn't start Google sign-in. Try again.");
    } finally {
      setIsSigningIn(false);
    }
  };

  const handlePrimarySignIn = () => {
    const hint = getLastUsedGoogleEmail();
    void startGoogleSignIn(hint ? { loginHint: hint } : {});
  };

  const handleDifferentAccountSignIn = () => {
    void startGoogleSignIn();
  };

  return (
    <div className="space-y-8 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
      <div className="space-y-4">
        <CircleGlyph />
        <div className="space-y-2">
          <h1 className="font-display text-3xl font-semibold tracking-tight">PocketCircle</h1>
          <p className="text-sm text-muted-foreground">Track money together in shared circles.</p>
        </div>
      </div>

      <div className="space-y-3">
        <Button
          size="lg"
          className="w-full"
          disabled={isSigningIn}
          aria-busy={isSigningIn}
          onClick={handlePrimarySignIn}
        >
          {isSigningIn ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
          {isSigningIn ? "Signing in..." : "Continue with Google"}
        </Button>

        {showLastUsedHint ? (
          <>
            <p className="text-xs text-muted-foreground">
              You used <span className="font-medium text-foreground">{maskedEmail}</span> last time.
            </p>
            <button
              type="button"
              disabled={isSigningIn}
              className="text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
              onClick={handleDifferentAccountSignIn}
            >
              Use a different account
            </button>
          </>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        By continuing you agree to our{" "}
        <Link
          to="/terms"
          className="underline underline-offset-2 transition-colors hover:text-foreground"
        >
          Terms
        </Link>{" "}
        and{" "}
        <Link
          to="/privacy"
          className="underline underline-offset-2 transition-colors hover:text-foreground"
        >
          Privacy Policy
        </Link>
        .
      </p>
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
