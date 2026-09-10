import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { InvitationPreview, InvitationPreviewById } from "~/lib/data/invitations.js";
import type { PendingInvitation } from "~/lib/data.js";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";

export interface InvitationsState {
  /** `invitations:createInvitation` mock; unset ⇒ no-op. */
  createInvitation?: Mock;
  /** `invitations:listPendingInvitations` return; unset ⇒ []. */
  pendingInvitations?: PendingInvitation[] | null;
  /** `invitations:resendInvitation` mock; unset ⇒ no-op. */
  resendInvitation?: Mock;
  /** `invitations:revokeInvitation` mock; unset ⇒ no-op. */
  revokeInvitation?: Mock;
  /** `invitations:acceptInvitation` mock; unset ⇒ no-op. */
  acceptInvitation?: Mock;
  /** `invitations:acceptInvitationById` mock; unset ⇒ no-op. */
  acceptInvitationById?: Mock;
  /** `invitations:getInvitationPreview` — `undefined` ≡ loading, `null` ≡ invalid. */
  invitationPreview?:
    | InvitationPreview
    | null
    | ((args: Record<string, unknown>) => InvitationPreview | null | undefined);
  /** `invitations:getInvitationPreviewById` — same semantics; includes canonical `ref`. */
  invitationPreviewById?:
    | InvitationPreviewById
    | null
    | ((args: Record<string, unknown>) => InvitationPreviewById | null | undefined);
}

export function invitationsDouble(state: InvitationsState): EntityDouble {
  const {
    createInvitation,
    pendingInvitations,
    resendInvitation,
    revokeInvitation,
    acceptInvitation,
    acceptInvitationById,
    invitationPreview,
    invitationPreviewById,
  } = state;
  return {
    queries: {
      [getFunctionName(api.invitations.listPendingInvitations)]: () => pendingInvitations,
      [getFunctionName(api.invitations.getInvitationPreview)]: (args) =>
        resolveWith(invitationPreview, args),
      [getFunctionName(api.invitations.getInvitationPreviewById)]: (args) =>
        resolveWith(
          invitationPreviewById !== undefined ? invitationPreviewById : invitationPreview,
          args,
        ),
    },
    mutations: {
      [getFunctionName(api.invitations.createInvitation)]: createInvitation,
      [getFunctionName(api.invitations.resendInvitation)]: resendInvitation,
      [getFunctionName(api.invitations.revokeInvitation)]: revokeInvitation,
      [getFunctionName(api.invitations.acceptInvitation)]: acceptInvitation,
      [getFunctionName(api.invitations.acceptInvitationById)]: acceptInvitationById,
    },
  };
}
