import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { SkeletonRegion } from "~/components/skeleton.js";
import { Button } from "~/components/ui/button.js";
import { confirmAccountDeletion, signInWithGoogle } from "~/lib/auth-client.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { useAppSession } from "~/lib/session.js";

const GENERIC_VERIFY_ERROR =
  "This deletion link is invalid or expired, or it doesn't match your signed-in account.";

/**
 * Public Account Deletion verification landing (USR-3). Waits for auth; signed-out
 * visitors sign in with this exact URL as callbackURL; signed-in visitors submit the
 * Better Auth token once. Never log or analytics-capture the token.
 */
export default function DeleteAccountVerify() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const session = useAppSession();
  const location = useLocation();
  const navigate = useNavigate();
  const submittedRef = useRef(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  const verifyPath = `${location.pathname}${location.search}`;
  const missingToken = !token;
  const displayError = missingToken ? GENERIC_VERIFY_ERROR : confirmError;

  useEffect(() => {
    if (!token || session.state !== "ready" || submittedRef.current) {
      return;
    }
    submittedRef.current = true;
    setConfirming(true);
    void confirmAccountDeletion(token)
      .then(async () => {
        await navigate("/delete-account/complete", { replace: true });
      })
      .catch((caught: unknown) => {
        setConfirming(false);
        setConfirmError(mutationErrorMessageForUser(caught, GENERIC_VERIFY_ERROR));
      });
  }, [token, session.state, navigate]);

  async function handleSignIn() {
    if (signingIn) {
      return;
    }
    setSignInError(null);
    setSigningIn(true);
    try {
      await signInWithGoogle(verifyPath);
    } catch {
      setSignInError("Couldn't start Google sign-in. Try again.");
    } finally {
      setSigningIn(false);
    }
  }

  if (displayError) {
    return (
      <div className="space-y-4 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Delete account</h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {displayError}
        </p>
        {session.state === "unauthenticated" ? (
          <div className="space-y-3">
            <Button
              type="button"
              className="w-full"
              disabled={signingIn}
              onClick={() => void handleSignIn()}
            >
              {signingIn ? "Signing in…" : "Sign in with Google"}
            </Button>
            {signInError ? (
              <p role="alert" className="text-sm text-destructive">
                {signInError}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Link
              to="/settings"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Back to Settings
            </Link>{" "}
            to request a new deletion email, or reopen the link after signing in.
          </p>
        )}
      </div>
    );
  }

  if (session.state === "loading" || confirming) {
    return (
      <div className="space-y-6 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Delete account</h1>
        <SkeletonRegion label="Confirming account deletion" testId="delete-account-verify-skeleton">
          <div className="mx-auto flex max-w-xs flex-col items-center gap-4">
            <span className="block h-4 w-48 animate-pulse-soft rounded-md bg-muted" />
            <span className="block h-3 w-56 animate-pulse-soft rounded-md bg-muted" />
          </div>
        </SkeletonRegion>
      </div>
    );
  }

  if (session.state === "unauthenticated") {
    return (
      <div className="space-y-4 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Delete account</h1>
        <p className="text-sm text-muted-foreground">
          Sign in with the same Google account to confirm account deletion.
        </p>
        <Button
          type="button"
          className="w-full"
          disabled={signingIn}
          onClick={() => void handleSignIn()}
        >
          {signingIn ? "Signing in…" : "Sign in with Google"}
        </Button>
        {signInError ? (
          <p role="alert" className="text-sm text-destructive">
            {signInError}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Delete account</h1>
      <SkeletonRegion label="Confirming account deletion" testId="delete-account-verify-skeleton">
        <div className="mx-auto flex max-w-xs flex-col items-center gap-4">
          <span className="block h-4 w-48 animate-pulse-soft rounded-md bg-muted" />
        </div>
      </SkeletonRegion>
    </div>
  );
}
