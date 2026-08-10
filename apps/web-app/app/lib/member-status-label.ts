import type { Member } from "./data/members.js";

/**
 * Filter/option detail for a historical Member (USR-3): Removed vs Deleted Account
 * stay distinct in Search/Ledger Paid By filters.
 */
export function historicalMemberStatusDetail(status: Member["status"]) {
  if (status === "removed") {
    return "removed";
  }
  if (status === "deleted") {
    return "deleted account";
  }
  return undefined;
}
