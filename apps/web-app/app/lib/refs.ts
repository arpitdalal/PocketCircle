import { type ParsedRef, parseRef, redactRefSlug } from "@spend-circle/domain";

/**
 * Client-side ID validator injected into the domain ref parser. It only rejects
 * obviously malformed segments; the authoritative check is server-side
 * (`ctx.db.normalizeId`), which returns null for invalid IDs (ADR 0016).
 */
function isConvexId(candidate: string): boolean {
  return /^[a-z0-9]+$/i.test(candidate);
}

/**
 * Parses a Circle ref from the URL. The Circle-scoped object guards parse
 * identically — same `isConvexId` validator, differing only in the route param
 * read and the query subscribed (ADR 0016); only the resolution adapter varies,
 * not the parser.
 */
export function parseCircleRef(ref: string | undefined): ParsedRef | null {
  if (!ref) {
    return null;
  }
  return parseRef(ref, isConvexId);
}

/**
 * Parses a Transaction ref from the `/transactions/:transactionRef/edit` object
 * route (TXN-5). Identical parsing to {@link parseCircleRef} — the same domain
 * `parseRef` + `isConvexId` (ADR 0016); only the route param and the subscribed
 * query (`getEditableTransaction`) differ, owned by `useResolvedTransaction`. A
 * malformed ref returns `null`, which the adapter treats as unparseable (an
 * app-emitted bad link) and reports while still falling back generically.
 */
export function parseTransactionRef(ref: string | undefined): ParsedRef | null {
  if (!ref) {
    return null;
  }
  return parseRef(ref, isConvexId);
}

/**
 * Parses a Category ref from `/categories/:categoryRef` object routes (issue #240).
 * Same parsing as the other ref parsers; only the route param differs.
 */
export function parseCategoryRef(ref: string | undefined): ParsedRef | null {
  if (!ref) {
    return null;
  }
  return parseRef(ref, isConvexId);
}

/** Strips title/name slugs from a ref before Sentry capture (ADR 0012, ADR 0013). */
export function redactRefForTelemetry(ref: string): string {
  return redactRefSlug(ref, isConvexId);
}
