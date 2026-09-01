import type { Doc } from "./_generated/dataModel.js";
import type { OperationReader } from "./operationReader.js";

/**
 * Effective Member identity for reads (USR-3 / ADR 0029). App User absence is
 * the immediate logical tombstone before durable cleanup materializes
 * `status: "deleted"` — so Profile Picture and live capacity drop instantly.
 */

export type EffectiveMemberStatus = "active" | "removed" | "deleted";

export async function resolveMemberIdentity(ctx: OperationReader, member: Doc<"members">) {
  const user = await ctx.db.get(member.userId);
  if (!user) {
    return {
      displayName: member.displayName,
      image: undefined,
      status: "deleted" as const satisfies EffectiveMemberStatus,
    };
  }
  return {
    displayName: member.displayName,
    image: member.image,
    status: member.status,
  };
}

/** Stored status must be active AND the referenced app User must still exist. */
export async function isEffectiveActiveMember(ctx: OperationReader, member: Doc<"members">) {
  if (member.status !== "active") {
    return false;
  }
  const user = await ctx.db.get(member.userId);
  return user !== null;
}
