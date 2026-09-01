import type { PaginationOptions } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import type { OperationReader } from "./operationReader.js";

/**
 * The immutable history audit (ADR 0018). Every Circle, Transaction, and
 * Category change is recorded as one append-only row — the event IS the row —
 * through `recordEvent`. This module is the single home of that write: handlers
 * never `ctx.db.insert("histories", …)` directly, so the event shape and the
 * "no raw IDs, frozen text" invariant live in exactly one place.
 *
 * The audit is immutable: each `change` carries frozen values written ONCE here
 * and never re-resolved, so a line always shows what was true when it was written.
 * Textual values are formatted by the caller BEFORE handing them over — dates as
 * plain `YYYY-MM-DD`, Members as their Display Name, Categories as their names —
 * and must never be a raw internal id.
 *
 * Money is the exception (ADR 0021): an amount change freezes a SEMANTIC money
 * value — `{ minorUnits, currency }` via the `moneyChange` helper — NOT a
 * formatted string. History stores meaning, not presentation, so the value can be
 * rendered for the viewer's locale at read time instead of being locked to the
 * server/terminal locale at write time. The typed `*Entity` constructors below are
 * the only way to name the audited entity, which keeps a stray string from being
 * mistaken for an entity id.
 *
 * `circleId` is an internal cascade key for bounded whole-Circle deletion
 * (USR-3 / ADR 0029) — never returned to clients or put in `changes`.
 */

/**
 * A change to one field of an entity. Textual fields use `from`/`to` (omitted on a
 * created/archived event respectively); MONEY fields use `fromMoney`/`toMoney`
 * (typed semantic values, ADR 0021) instead — build them with `moneyChange`.
 */
export interface HistoryChange {
  field: string;
  from?: string;
  to?: string;
  fromMoney?: HistoryMoney;
  toMoney?: HistoryMoney;
}

/** A frozen semantic money value: integer minor units plus the ISO Currency at event time (ADR 0021). */
export interface HistoryMoney {
  minorUnits: number;
  currency: string;
}

/**
 * Builds a money `HistoryChange` from typed semantic values (ADR 0021). Pass the
 * Circle Currency at event time; `from` is omitted on a created event. This keeps
 * amount events off the preformatted-string path entirely — no `Intl` at write
 * time, so a server/terminal locale can never leak into a frozen history row.
 */
export function moneyChange(field: string, to: HistoryMoney, from?: HistoryMoney): HistoryChange {
  return { field, ...(from ? { fromMoney: from } : {}), toMoney: to };
}

/**
 * The audited entity, produced by the typed `*Entity` constructors. Wrapping the
 * id in a branded carrier (rather than passing a bare string) means `recordEvent`
 * cannot be handed an arbitrary string, and the call site reads as the entity it
 * audits.
 */
export interface HistoryEntity {
  readonly entityId: string;
  readonly circleId: Id<"circles">;
}

export function circleEntity(id: Id<"circles">): HistoryEntity {
  return { entityId: id, circleId: id };
}

export function transactionEntity(id: Id<"transactions">, circleId: Id<"circles">): HistoryEntity {
  return { entityId: id, circleId };
}

export function categoryEntity(id: Id<"categories">, circleId: Id<"circles">): HistoryEntity {
  return { entityId: id, circleId };
}

export interface RecordEventArgs {
  /** The audited entity (use a `*Entity` constructor). */
  entity: HistoryEntity;
  /** The acting Member, or null for a system action. */
  actor: Doc<"members"> | null;
  /** The action verb, e.g. "created" | "renamed" | "archived". */
  action: string;
  /** Field-level changes, with `from`/`to` already formatted as frozen human strings. */
  changes: HistoryChange[];
}

/**
 * Appends one immutable event row to the audit. The only writer of `histories`.
 */
export async function recordEvent(ctx: MutationCtx, args: RecordEventArgs) {
  await ctx.db.insert("histories", {
    entityId: args.entity.entityId,
    circleId: args.entity.circleId,
    actorMemberId: args.actor?._id,
    action: args.action,
    changes: args.changes,
    createdAt: Date.now(),
  });
}

/** An entity's history, newest first — the canonical read for a detail surface (PRD story 80). */
export async function listEntityHistory(ctx: OperationReader, entity: HistoryEntity) {
  return await ctx.db
    .query("histories")
    .withIndex("by_entity_and_createdAt", (q) => q.eq("entityId", entity.entityId))
    .order("desc")
    .collect();
}

/**
 * One newest-first page of an entity's history, paginated at the source (README
 * §4: history is an unbounded-growth set, so the detail view must never `.collect()`
 * the whole audit and slice in memory). Ranges the SAME `by_entity` index
 * {@link listEntityHistory} uses, so the page is index-backed and bounded. The
 * canonical read for a paginated detail surface (Transaction History — PRD story 80;
 * Category/Circle History reuse it).
 */
export async function paginateEntityHistory(
  ctx: OperationReader,
  entity: HistoryEntity,
  paginationOpts: PaginationOptions,
) {
  return await ctx.db
    .query("histories")
    .withIndex("by_entity_and_createdAt", (q) => q.eq("entityId", entity.entityId))
    .order("desc")
    .paginate(paginationOpts);
}

/** The newest event recorded for an entity, or null when none exist yet. Backs the
 * Audit Metadata "updated-by / updated-at" (the last Member to change the record),
 * a single bounded `by_entity` lookup rather than collecting the whole history. */
export async function latestEntityEvent(ctx: OperationReader, entity: HistoryEntity) {
  return await ctx.db
    .query("histories")
    .withIndex("by_entity_and_createdAt", (q) => q.eq("entityId", entity.entityId))
    .order("desc")
    .first();
}
