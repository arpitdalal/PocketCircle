import { LoaderCircle } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button.js";
import { type SignInWithGoogleOptions, signInWithGoogle } from "~/lib/auth-client.js";
import {
  getLastUsedGoogleEmail,
  getMaskedLastUsedGoogleEmail,
  subscribeLastUsedGoogleEmail,
} from "~/lib/last-used-google-email.js";

/**
 * Shared Google sign-in controls (ADR 0014). Used on the marketing homepage and
 * `/signin` so visitors start OAuth in one click instead of bouncing between pages.
 */
export function GoogleSignInPanel({
  returnTo = "/",
  buttonClassName,
}: {
  returnTo?: string;
  buttonClassName?: string;
}) {
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
      await signInWithGoogle(returnTo, options);
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
    <div className="space-y-3">
      <Button
        size="lg"
        className={buttonClassName ?? "w-full"}
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
