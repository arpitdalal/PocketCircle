import { z } from "zod";

function defineMutationError<const Code extends string>(code: Code, message: string) {
  return Object.freeze({ code, message });
}

function defineMutationErrorCatalog<
  const T extends Record<string, { readonly code: string; readonly message: string }>,
>(catalog: T) {
  const errors = Object.freeze(catalog);
  const codes = Object.values(errors).map((error) => error.code);
  if (codes.length === 0) {
    throw new Error("Mutation error catalog must define at least one error");
  }
  const [firstCode, ...restCodes] = codes;
  if (firstCode === undefined) {
    throw new Error("Mutation error catalog must define at least one error");
  }
  const dataSchema = z.object({
    code: z.enum([firstCode, ...restCodes]),
  });

  type Code = T[keyof T]["code"];

  return {
    errors,
    dataSchema: dataSchema satisfies z.ZodType<{ code: Code }>,
    errorData(error: { code: Code }) {
      return { code: error.code };
    },
    messageForCode(code: string) {
      return Object.values(errors).find((entry) => entry.code === code)?.message ?? null;
    },
  };
}

const mutationErrors = defineMutationErrorCatalog({
  circleArchived: defineMutationError("circle.archived", "Circle is archived"),
  /**
   * Missing Circle and no-access collapse to the same coded error (ADR 0016).
   * Prefer this over a plain `Error` so clients still classify it after Convex
   * redacts uncoded mutation failures in production.
   */
  circleUnavailable: defineMutationError("circle.unavailable", "Circle not found"),
  circleSetupIncomplete: defineMutationError(
    "circle.setupIncomplete",
    "Finish setting up this Circle before continuing",
  ),
  circleCapacityReached: defineMutationError(
    "circle.capacityReached",
    "This Circle is full. The invitation can't be accepted right now.",
  ),
  circleCapacityFull: defineMutationError(
    "circle.capacityFull",
    "This Circle is full. Free a seat by revoking a pending invitation or removing a member, then try again.",
  ),
  categoryNameDuplicate: defineMutationError(
    "category.nameDuplicate",
    "A category with this name already exists for this type",
  ),
  inviteForbidden: defineMutationError(
    "invite.forbidden",
    "Only the Circle owner can invite members",
  ),
  invitePersonalCircle: defineMutationError(
    "invite.personalCircle",
    "Personal Circles can't have other members",
  ),
  inviteAlreadyMember: defineMutationError(
    "invite.alreadyMember",
    "That person is already a member of this Circle",
  ),
  inviteAlreadyPending: defineMutationError(
    "invite.alreadyPending",
    "There's already a pending invitation for that email",
  ),
  inviteInvalid: defineMutationError("invite.invalid", "This invitation is no longer valid."),
  memberNotFound: defineMutationError(
    "member.notFound",
    "This member is no longer part of this Circle.",
  ),
  memberCannotRemoveOwner: defineMutationError(
    "member.cannotRemoveOwner",
    "The Circle owner can't be removed — transfer ownership first.",
  ),
  transferForbidden: defineMutationError(
    "transfer.forbidden",
    "Only the Circle owner can transfer ownership",
  ),
  transferPersonalCircle: defineMutationError(
    "transfer.personalCircle",
    "Ownership of a Personal Circle can't be transferred",
  ),
  transferToSelf: defineMutationError("transfer.toSelf", "You're already the owner of this Circle"),
  transferTargetNotMember: defineMutationError(
    "transfer.targetNotMember",
    "That person isn't an active member of this Circle",
  ),
  memberRemoveForbidden: defineMutationError(
    "member.removeForbidden",
    "Only the Circle owner can remove members",
  ),
  inviteResendCapReached: defineMutationError(
    "invite.resendCapReached",
    "This invitation has been resent too many times today. Try again tomorrow.",
  ),
  inviteAddressCapReached: defineMutationError(
    "invite.addressCapReached",
    "Too many invitations have been sent to this email today. Try again tomorrow.",
  ),
  inviteDailyCapReached: defineMutationError(
    "invite.dailyCapReached",
    "You've sent too many invitation emails today. Try again tomorrow.",
  ),
  feedbackDailyCapReached: defineMutationError(
    "feedback.dailyCapReached",
    "You've sent too much feedback today. Try again tomorrow.",
  ),
  leavePersonalCircle: defineMutationError(
    "leave.personalCircle",
    "You can't leave your Personal Circle",
  ),
  ownerMustTransfer: defineMutationError(
    "member.ownerMustTransfer",
    "Transfer ownership before leaving",
  ),
  circleDeleteForbidden: defineMutationError(
    "circle.delete.forbidden",
    "Only the Circle owner can delete this circle",
  ),
  circleDeletePersonal: defineMutationError(
    "circle.delete.personal",
    "Personal Circles can't be deleted",
  ),
  circleDeleteHasMembers: defineMutationError(
    "circle.delete.hasMembers",
    "This circle has other members — archive it instead of deleting",
  ),
  circleDeleteNotEmpty: defineMutationError(
    "circle.delete.notEmpty",
    "This circle has transactions — archive it instead of deleting",
  ),
  currencyLocked: defineMutationError(
    "currency.locked",
    "Currency is locked once the circle has a transaction",
  ),
  /**
   * Create submitted against a stale client-observed Currency (Global Add #298).
   * Client applies the Amount-only reset contract; do not treat as full Circle loss.
   */
  currencyChanged: defineMutationError("currency.changed", "The Circle's currency changed"),
  currencyForbidden: defineMutationError(
    "currency.forbidden",
    "Only the Circle owner can change the currency",
  ),
  currencyUnsupported: defineMutationError("currency.unsupported", "That currency isn't supported"),
  accountDeletionBlocked: defineMutationError(
    "accountDeletion.blocked",
    "Archive or transfer Circles you own before deleting your account",
  ),
  mcpHandoffInvalid: defineMutationError(
    "mcp.handoffInvalid",
    "This authorization request is no longer valid. Ask the app to connect again.",
  ),
  mcpScopesInvalid: defineMutationError(
    "mcp.scopesInvalid",
    "The requested access can't be granted",
  ),
  mcpCirclesInvalid: defineMutationError(
    "mcp.circlesInvalid",
    "Select at least one Circle you can access",
  ),
  mcpOnboardingRequired: defineMutationError(
    "mcp.onboardingRequired",
    "Finish setting up your account before connecting an app",
  ),
  mcpGrantFailed: defineMutationError(
    "mcp.grantFailed",
    "This authorization request couldn't be completed",
  ),
});

export const MUTATION_ERRORS = mutationErrors.errors;
export const mutationErrorDataSchema = mutationErrors.dataSchema;
export const mutationErrorData = mutationErrors.errorData;
export const mutationErrorMessageForCode = mutationErrors.messageForCode;

export type MutationErrorCode = (typeof MUTATION_ERRORS)[keyof typeof MUTATION_ERRORS]["code"];

type MutationErrorCodeIsLiteralUnion = MutationErrorCode extends string
  ? string extends MutationErrorCode
    ? never
    : true
  : never;

const _mutationErrorCodeIsLiteralUnion: MutationErrorCodeIsLiteralUnion = true;
