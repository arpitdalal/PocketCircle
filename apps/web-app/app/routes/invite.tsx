import { MUTATION_ERRORS } from "@pocketcircle/domain";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { href, Link, useNavigate, useParams } from "react-router";
import { SkeletonRegion } from "~/components/skeleton.js";
import { Avatar } from "~/components/ui/avatar.js";
import { Button } from "~/components/ui/button.js";
import { signInWithGoogle } from "~/lib/auth-client.js";
import { type InvitationPreview, useAcceptInvitation, useInvitationPreview } from "~/lib/data.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { useAppSession } from "~/lib/session.js";

/**
 * Opaque token-only Invitation landing (ADR 0016 exception). The token is
 * validated server-side before any Circle context is revealed; preview fields
 * are the minimal surface `getInvitationPreview` returns.
 */
export default function Invite() {
  const { token } = useParams();
  const preview = useInvitationPreview(token);
  const session = useAppSession();

  if (preview === undefined) {
    return <InviteLoading />;
  }

  if (preview === null) {
    return <InviteInvalid />;
  }

  if (session.state === "loading") {
    return <InviteLoading />;
  }

  if (session.state === "unauthenticated") {
    return <InvitePreview preview={preview} token={token ?? ""} signedIn={false} />;
  }

  return <InvitePreview preview={preview} token={token ?? ""} signedIn />;
}

function InviteLoading() {
  return (
    <div className="space-y-6 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
      <h1 className="font-display text-2xl font-semibold tracking-tight">
        You&apos;ve been invited
      </h1>
      <SkeletonRegion label="Loading invitation" testId="invite-skeleton">
        <div className="mx-auto flex max-w-xs flex-col items-center gap-4">
          <span className="block size-12 animate-pulse-soft rounded-full bg-muted" />
          <span className="block h-4 w-40 animate-pulse-soft rounded-md bg-muted" />
          <span className="block h-3 w-56 animate-pulse-soft rounded-md bg-muted" />
        </div>
      </SkeletonRegion>
    </div>
  );
}

function InviteInvalid() {
  return (
    <div className="space-y-4 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
      <h1 className="font-display text-2xl font-semibold tracking-tight">
        You&apos;ve been invited
      </h1>
      <p role="alert" className="text-sm text-muted-foreground">
        {MUTATION_ERRORS.inviteInvalid.message}
      </p>
    </div>
  );
}

function InvitePreview({
  preview,
  token,
  signedIn,
}: {
  preview: InvitationPreview;
  token: string;
  signedIn: boolean;
}) {
  const navigate = useNavigate();
  const acceptInvitation = useAcceptInvitation();
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  const invitePath = `/invite/${token}`;

  async function handleSignIn() {
    if (signingIn) {
      return;
    }
    setSignInError(null);
    setSigningIn(true);
    try {
      await signInWithGoogle(invitePath, { loginHint: preview.invitedEmail });
    } catch {
      setSignInError("Couldn't start Google sign-in. Try again.");
    } finally {
      setSigningIn(false);
    }
  }

  async function handleAccept() {
    if (accepting || !token) {
      return;
    }
    setAcceptError(null);
    setAccepting(true);
    try {
      const { circleId } = await acceptInvitation({ token });
      await navigate(href("/circles/:circleRef", { circleRef: circleId }), { replace: true });
    } catch (caught) {
      setAcceptError(mutationErrorMessageForUser(caught, "Something went wrong"));
    } finally {
      setAccepting(false);
    }
  }

  return (
    <div className="space-y-6 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
      <div className="space-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          You&apos;ve been invited
        </h1>
        <p className="text-sm text-muted-foreground">
          Join <span className="font-medium text-foreground">{preview.circleName}</span>
        </p>
      </div>

      <div className="flex flex-col items-center gap-3">
        <Avatar name={preview.ownerDisplayName} image={preview.ownerImage ?? undefined} />
        <p className="text-sm">
          <span className="font-medium">{preview.ownerDisplayName}</span> invited you
        </p>
        <p className="text-xs text-muted-foreground">
          Invitation for <span className="text-foreground">{preview.invitedEmail}</span>
        </p>
      </div>

      {signedIn ? (
        <>
          <Button
            size="lg"
            className="w-full"
            disabled={accepting}
            aria-busy={accepting}
            onClick={() => void handleAccept()}
          >
            {accepting ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
            {accepting ? "Accepting…" : "Accept invitation"}
          </Button>
          {acceptError ? (
            <p role="alert" className="text-sm text-destructive">
              {acceptError}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <Button
            size="lg"
            className="w-full"
            disabled={signingIn}
            aria-busy={signingIn}
            onClick={() => void handleSignIn()}
          >
            {signingIn ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
            {signingIn ? "Signing in…" : "Sign in to accept"}
          </Button>
          {signInError ? (
            <p role="alert" className="text-sm text-destructive">
              {signInError}
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
        </>
      )}
    </div>
  );
}
