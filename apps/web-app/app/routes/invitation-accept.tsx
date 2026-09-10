import { MUTATION_ERRORS } from "@pocketcircle/domain";
import { useEffect, useState } from "react";
import { href, useLocation, useNavigate, useParams } from "react-router";
import {
  InviteAcceptPanel,
  InviteInvalidPanel,
  InviteLoadingPanel,
} from "~/components/invite-accept-panel.js";
import { useAcceptInvitationById, useInvitationPreviewById } from "~/lib/data/invitations.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { parseInvitationRef } from "~/lib/refs.js";
import { canonicalizeRefSegment } from "~/lib/use-resolved-ref.js";

/**
 * Authenticated Invitation acceptance view addressed by Invitation identity
 * (#375). Opened from Notification Center links — never carries the emailed token.
 * Invalid/unavailable stays on-page (same generic panel as `/invite/:token`)
 * rather than the object-guard snackbar+fallback, because invitees are not yet
 * Circle Members and have no safe Circle fallback.
 */
export default function InvitationAccept() {
  const { invitationRef } = useParams();
  const parsed = parseInvitationRef(invitationRef);
  const invitationId = parsed?.id;
  const preview = useInvitationPreviewById(invitationId);
  const navigate = useNavigate();
  const location = useLocation();
  const acceptInvitationById = useAcceptInvitationById();
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  useEffect(() => {
    if (!preview || !invitationRef || preview.ref === invitationRef) {
      return;
    }
    void navigate(canonicalizeRefSegment(location, invitationRef, preview.ref), {
      replace: true,
    });
  }, [preview, invitationRef, location, navigate]);

  if (!invitationId) {
    return <InviteInvalidPanel message={MUTATION_ERRORS.inviteInvalid.message} />;
  }

  if (preview === undefined) {
    return <InviteLoadingPanel />;
  }

  if (preview === null) {
    return <InviteInvalidPanel message={MUTATION_ERRORS.inviteInvalid.message} />;
  }

  if (preview.ref !== invitationRef) {
    return <InviteLoadingPanel />;
  }

  async function handleAccept() {
    if (accepting || !invitationId) {
      return;
    }
    setAcceptError(null);
    setAccepting(true);
    try {
      const { circleId } = await acceptInvitationById({ invitationId });
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
      signedIn
    />
  );
}
