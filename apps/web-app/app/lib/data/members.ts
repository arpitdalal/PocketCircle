import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";
import { MOCK_MEMBERS } from "../fixtures.js";
import type { Circle } from "./circles.js";

/**
 * The single Member view contract, derived from `listMembers` so it cannot drift
 * from `toMemberView` in `packages/convex/convex/members.ts` (ADR 0003). The query
 * returns `MemberView[] | null` (null ≡ inaccessible Circle — ADR 0016); this is
 * one element of that array.
 */
export type Member = NonNullable<FunctionReturnType<typeof api.members.listMembers>>[number];

/**
 * A Circle's active Members, Owner first. `undefined` while loading; `null` when
 * the Circle is inaccessible (ADR 0016). Feeds the Transaction form's Paid By
 * selector; MEM-1 layers the full Member List UI on the same query. Mock mode
 * returns fixtures and skips the backend (ADR 0006). An `undefined` circleId
 * (Global Add's unselected destination) skips the subscription and reads as
 * loading.
 */
export function useMembers(circleId: Circle["id"] | undefined) {
  const queried = useQuery(
    api.members.listMembers,
    MOCKS || circleId === undefined ? "skip" : { circleId },
  );
  if (MOCKS) {
    return circleId === undefined ? undefined : MOCK_MEMBERS;
  }
  return queried;
}

export function useTransferOwnership() {
  return useMutation(api.members.transferOwnership);
}

export function useRemoveMember() {
  return useMutation(api.members.removeMember);
}

/** Self-service leave mutation (MEM-6). */
export function useLeaveCircle() {
  return useMutation(api.members.leaveCircle);
}
