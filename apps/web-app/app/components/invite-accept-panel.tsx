import { LoaderCircle } from "lucide-react";
import { Link } from "react-router";
import { SkeletonRegion } from "~/components/skeleton.js";
import { Avatar } from "~/components/ui/avatar.js";
import { Button } from "~/components/ui/button.js";
import type { InvitationPreview } from "~/lib/data/invitations.js";

/**
 * Shared Invitation acceptance panel for the emailed-token landing and the
 * authenticated Notification Center destination (#375).
 */
export function InviteAcceptPanel({
  preview,
  accepting,
  acceptError,
  onAccept,
  signedIn,
  signingIn,
  signInError,
  onSignIn,
}: {
  preview: InvitationPreview;
  accepting: boolean;
  acceptError: string | null;
  onAccept: () => void;
  signedIn: boolean;
  signingIn?: boolean;
  signInError?: string | null;
  onSignIn?: () => void;
}) {
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
            onClick={onAccept}
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
            onClick={onSignIn}
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

export function InviteLoadingPanel() {
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

export function InviteInvalidPanel({ message }: { message: string }) {
  return (
    <div className="space-y-4 rounded-xl border border-border bg-card/60 p-8 text-center shadow-xl backdrop-blur-sm">
      <h1 className="font-display text-2xl font-semibold tracking-tight">
        You&apos;ve been invited
      </h1>
      <p role="alert" className="text-sm text-muted-foreground">
        {message}
      </p>
    </div>
  );
}
