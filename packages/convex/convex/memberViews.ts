import type { Doc } from "./_generated/dataModel.js";
import { resolveMemberIdentity } from "./memberIdentity.js";
import type { OperationReader } from "./operationReader.js";

/** The shared Member List projection used by web, search, and MCP reads. */
export async function toMemberView(
  ctx: OperationReader,
  member: Doc<"members">,
  currentMemberId: Doc<"members">["_id"],
) {
  const identity = await resolveMemberIdentity(ctx, member);
  return {
    id: member._id,
    displayName: identity.displayName,
    image: identity.image,
    role: member.role,
    status: identity.status,
    joinedAt: member.joinedAt,
    isSelf: member._id === currentMemberId,
  };
}

export type MemberView = Awaited<ReturnType<typeof toMemberView>>;
