import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { Member } from "~/lib/data.js";
import type { EntityDouble } from "./contract.js";
import { testId } from "./ids.js";

export interface MembersState {
  /** `listMembers` — `undefined` ≡ loading, `null` ≡ inaccessible. */
  members?: Member[] | null;
  transferOwnership?: Mock;
  removeMember?: Mock;
  /** `members:leaveCircle` mock; unset ⇒ no-op. */
  leaveCircle?: Mock;
}

export function membersDouble(state: MembersState): EntityDouble {
  const { members, transferOwnership, removeMember, leaveCircle } = state;
  return {
    queries: {
      [getFunctionName(api.members.listMembers)]: () => members,
    },
    mutations: {
      [getFunctionName(api.members.transferOwnership)]: transferOwnership,
      [getFunctionName(api.members.removeMember)]: removeMember,
      [getFunctionName(api.members.leaveCircle)]: leaveCircle,
    },
  };
}

export function makeMemberView(over: Partial<Member> = {}): Member {
  return {
    id: testId<Member["id"]>("mem-you"),
    displayName: "You",
    image: undefined,
    role: "owner",
    status: "active",
    joinedAt: 0,
    isSelf: true,
    ...over,
  };
}
