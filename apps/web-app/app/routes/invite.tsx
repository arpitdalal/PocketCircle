import { MUTATION_ERRORS } from "@pocketcircle/domain";
import { useState } from "react";
import { href, useNavigate, useParams } from "react-router";
import {
  InviteAcceptPanel,
  InviteInvalidPanel,
  InviteLoadingPanel,
} from "~/components/invite-accept-panel.js";
import { signInWithGoogle } from "~/lib/auth-client.js";
import { useAcceptInvitation, useInvitationPreview } from "~/lib/data.js";
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
    return <InviteLoadingPanel />;
  }

  if (preview === null) {
    return <InviteInvalidPanel message={MUTATION_ERRORS.inviteInvalid.message} />;
  }

  if (session.state === "loading") {
    return <InviteLoadingPanel />;
  }

  if (session.state === "unauthenticated") {
    return <TokenInvitePreview preview={preview} token={token ?? ""} signedIn={false} />;
  }

  return <TokenInvitePreview preview={preview} token={token ?? ""} signedIn />;
}

function TokenInvitePreview({
  preview,
  token,
  signedIn,
}: {
  preview: NonNullable<ReturnType<typeof useInvitationPreview>>;
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
    <InviteAcceptPanel
      preview={preview}
      accepting={accepting}
      acceptError={acceptError}
      onAccept={() => void handleAccept()}
      signedIn={signedIn}
      signingIn={signingIn}
      signInError={signInError}
      onSignIn={() => void handleSignIn()}
    />
  );
}
