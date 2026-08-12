import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";
import { MOCK_INVITATION_PREVIEW, MOCK_PENDING_INVITATIONS } from "../fixtures.js";
import type { Circle } from "./circles.js";

/**
 * The Create-Invitation mutation (MEM-2), behind the data seam so the route
 * imports no Convex internals. Server-side email delivery is enqueued by the
 * mutation (EML-2); the client receives no plaintext token.
 */
export function useCreateInvitation() {
  return useMutation(api.invitations.createInvitation);
}

/** Derived view type — cannot drift from `listPendingInvitations` return shape (ADR 0003). */
export type PendingInvitation = NonNullable<
  FunctionReturnType<typeof api.invitations.listPendingInvitations>
>[number];

/** Owner-only pending invitations for a Circle. null = no permission / inaccessible.
 *  undefined = loading. Mock mode returns MOCK_PENDING_INVITATIONS. */
export function usePendingInvitations(
  circleId: Circle["id"],
): PendingInvitation[] | null | undefined {
  const queried = useQuery(api.invitations.listPendingInvitations, MOCKS ? "skip" : { circleId });
  return MOCKS ? MOCK_PENDING_INVITATIONS : queried;
}

export function useResendInvitation() {
  return useMutation(api.invitations.resendInvitation);
}

export function useRevokeInvitation() {
  return useMutation(api.invitations.revokeInvitation);
}

export function useAcceptInvitation() {
  return useMutation(api.invitations.acceptInvitation);
}

export type InvitationPreview = NonNullable<
  FunctionReturnType<typeof api.invitations.getInvitationPreview>
>;

export function useInvitationPreview(
  token: string | undefined,
): InvitationPreview | null | undefined {
  const queried = useQuery(
    api.invitations.getInvitationPreview,
    MOCKS || !token ? "skip" : { token },
  );
  return MOCKS ? MOCK_INVITATION_PREVIEW : queried;
}
