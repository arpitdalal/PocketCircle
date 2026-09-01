import type { Doc, Id } from "./_generated/dataModel.js";
import { resolveMemberIdentity } from "./memberIdentity.js";
import type { OperationReader } from "./operationReader.js";

/**
 * The client-facing shape of one immutable history event — the read-side
 * counterpart of `history.ts`'s `recordEvent`, shared by every entity History
 * surface (Transaction History — TXN-4; Category History — CAT-2; Circle History
 * — CS-4). One definition so the surfaces can't drift and the web's shared
 * `HistoryList` renders all of them.
 *
 * The acting Member resolves to their effective Display Name + image (memoized
 * through `cache` so a page of events touching the same actor reads the row once
 * — no N+1); a system event (no actor) surfaces `actor: null`. The `changes`
 * array passes straight through: it already holds frozen display-safe values
 * (text `from`/`to`, typed `fromMoney`/`toMoney`) and NEVER a raw id (ADR
 * 0018/0021). The Member id is deliberately dropped from the event — the UI
 * needs only the display identity, keeping raw IDs off the surface entirely
 * (PRD story 80).
 */

interface ActorRef {
  displayName: string;
  image?: string;
}

/** Per-query actor lookup cache. Scoped to a single query call — never shared
 * across requests. */
export type ActorCache = Map<Id<"members">, ActorRef>;

export function newActorCache(): ActorCache {
  return new Map();
}

async function actorRef(
  ctx: OperationReader,
  memberId: Id<"members">,
  cache: ActorCache,
): Promise<ActorRef> {
  const cached = cache.get(memberId);
  if (cached) {
    return cached;
  }
  const member = await ctx.db.get(memberId);
  if (!member) {
    const ref: ActorRef = { displayName: "Unknown member" };
    cache.set(memberId, ref);
    return ref;
  }
  const identity = await resolveMemberIdentity(ctx, member);
  const ref: ActorRef = {
    displayName: identity.displayName,
    image: identity.image,
  };
  cache.set(memberId, ref);
  return ref;
}

/** One history event shaped for the client. */
export async function toHistoryEventView(
  ctx: OperationReader,
  event: Doc<"histories">,
  cache: ActorCache,
) {
  const actor =
    event.actorMemberId != null ? await actorRef(ctx, event.actorMemberId, cache) : null;
  return {
    id: event._id,
    action: event.action,
    createdAt: event.createdAt,
    actor,
    changes: event.changes,
  };
}

export type HistoryEventView = Awaited<ReturnType<typeof toHistoryEventView>>;
