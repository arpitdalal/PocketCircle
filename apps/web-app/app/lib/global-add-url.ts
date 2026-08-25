import { isTransactionType, type TransactionType } from "@pocketcircle/domain";
import { withQuery } from "./ledger-url.js";
import { parseCircleRef, parseTransactionRef } from "./refs.js";
import { parseReturnTo, RETURN_TO_PARAM, withReturnTo } from "./return-to-url.js";

/**
 * The one URL codec for Global Add (issues #298/#299, ADR 0016/0017): the
 * canonical builder, parser, and normalizer for the protected top-level
 * `/transactions/new` route. It owns every rule about which parameters the
 * route recognizes (`type`, `circle`, optional Duplicate `sourceCircle` /
 * `sourceTransaction`, `returnTo`), how a raw value becomes trusted state, and
 * what the canonical URL for that state looks like — so no link, guard, or
 * test can drift from the contract.
 *
 * Normalization rules (issues #290/#293):
 *  - Missing or malformed `type` normalizes to `expense`.
 *  - `circle` is the canonical `slug-id` Circle ref; it parses to its
 *    authoritative id (raw ids and stale slugs both resolve by id). An absent
 *    param is a valid unselected state; an UNPARSEABLE one is kept in the
 *    raw param so canonicalize cannot erase the feedback flag before the
 *    route's unavailable path strips it.
 *  - `sourceCircle` + `sourceTransaction` are a pair. Both absent means
 *    ordinary Global Add. Anything other than exactly one usable parseable
 *    value for each is an unusable pair (indistinguishable unavailable-source
 *    recovery). Usable refs accept raw ids and stale slugs; resolution is by
 *    id after Circle Visibility.
 *  - `returnTo` reuses the app-wide safe-origin codec; anything unsafe falls
 *    back to Home (`/`) and is indistinguishable from absent.
 *  - Unknown and duplicate parameters simply never reach the canonical output —
 *    rebuilding the query from parsed state drops them.
 */

export const GLOBAL_ADD_PATH = "/transactions/new";

const TYPE_PARAM = "type";
const CIRCLE_PARAM = "circle";
const SOURCE_CIRCLE_PARAM = "sourceCircle";
const SOURCE_TRANSACTION_PARAM = "sourceTransaction";

export interface GlobalAddHrefInput {
  type: TransactionType;
  /** Canonical Circle ref to select on open; omit for an unselected page. */
  circleRef?: string;
  /** Validated return origin (see `withReturnTo`); omit to fall back to Home. */
  returnTo?: string;
  /** Canonical source Circle ref for Duplicate initialization; pair with transaction. */
  sourceCircleRef?: string;
  /** Canonical source Transaction ref for Duplicate initialization; pair with Circle. */
  sourceTransactionRef?: string;
}

function appendSourcePairParams(
  params: URLSearchParams,
  sourceCircleRef: string | undefined,
  sourceTransactionRef: string | undefined,
) {
  if (sourceCircleRef && sourceTransactionRef) {
    params.set(SOURCE_CIRCLE_PARAM, sourceCircleRef);
    params.set(SOURCE_TRANSACTION_PARAM, sourceTransactionRef);
  }
}

/**
 * Canonical Global Add URL builder — the single home every caller (Home's
 * primary action, the Activation Checklist, Transaction Detail Duplicate,
 * tests) builds the create link through, so the path and parameter names can't
 * drift. Optional `returnTo` merges through the shared `withReturnTo` codec
 * (callers that already wrap the result may omit it). Source params are
 * emitted only as a complete pair.
 */
export function globalAddHref({
  type,
  circleRef,
  returnTo,
  sourceCircleRef,
  sourceTransactionRef,
}: GlobalAddHrefInput) {
  const params = new URLSearchParams({ [TYPE_PARAM]: type });
  if (circleRef) {
    params.set(CIRCLE_PARAM, circleRef);
  }
  appendSourcePairParams(params, sourceCircleRef, sourceTransactionRef);
  return withReturnTo(withQuery(GLOBAL_ADD_PATH, params.toString()), returnTo);
}

/** The raw query values exactly as the URL carried them (first duplicate wins). */
export interface RawGlobalAddParams {
  type: string | null;
  circle: string | null;
  sourceCircle: string | null;
  sourceTransaction: string | null;
  returnTo: string | null;
}

export function readGlobalAddParams(searchParams: URLSearchParams) {
  return {
    type: searchParams.get(TYPE_PARAM),
    circle: searchParams.get(CIRCLE_PARAM),
    sourceCircle: searchParams.get(SOURCE_CIRCLE_PARAM),
    sourceTransaction: searchParams.get(SOURCE_TRANSACTION_PARAM),
    returnTo: searchParams.get(RETURN_TO_PARAM),
  };
}

/**
 * Parsed Duplicate source pair. `absent` is ordinary Global Add; `candidate`
 * has both ids ready for Circle Visibility + `getTransaction`; `unusable` is
 * every partial/malformed/duplicate-garbage shape that must recover through
 * the same unavailable-source path without probing existence.
 */
export type GlobalAddSourcePair =
  | { kind: "absent" }
  | {
      kind: "candidate";
      sourceCircleId: string;
      sourceCircleRefParam: string;
      sourceTransactionId: string;
      sourceTransactionRefParam: string;
    }
  | { kind: "unusable" };

/**
 * The trusted URL-owned state after normalization. This is everything the route
 * derives from the address bar; draft fields deliberately live only in form
 * memory (issue #298). Source refs stay URL-owned so reload can initialize
 * again; they are not a live relationship after one-time prefill (issue #299).
 */
export interface GlobalAddUrlState {
  type: TransactionType;
  /** Authoritative Circle id from the `circle` param; null when absent/unparseable. */
  circleId: string | null;
  /**
   * The raw `circle` query value as carried. Kept for parseable refs (stale-slug
   * comparison + URL pin) AND for unparseable values so canonicalize cannot
   * strip them before the unavailable-feedback path runs. Null when absent.
   */
  circleRefParam: string | null;
  /** Validated return origin; Home when missing/unsafe. */
  returnTo: string;
  /** A `circle` param was present but did not parse — generic-feedback-worthy. */
  hadUnparseableCircle: boolean;
  /** Normalized Duplicate source pair (absent / candidate / unusable). */
  sourcePair: GlobalAddSourcePair;
}

function parseSourcePair(sourceCircle: string | null, sourceTransaction: string | null) {
  if (sourceCircle == null && sourceTransaction == null) {
    return { kind: "absent" as const };
  }
  if (sourceCircle == null || sourceTransaction == null) {
    return { kind: "unusable" as const };
  }
  const parsedCircle = parseCircleRef(sourceCircle);
  const parsedTransaction = parseTransactionRef(sourceTransaction);
  if (parsedCircle === null || parsedTransaction === null) {
    return { kind: "unusable" as const };
  }
  return {
    kind: "candidate" as const,
    sourceCircleId: parsedCircle.id,
    sourceCircleRefParam: sourceCircle,
    sourceTransactionId: parsedTransaction.id,
    sourceTransactionRefParam: sourceTransaction,
  };
}

export function parseGlobalAddParams(raw: RawGlobalAddParams) {
  const type = raw.type != null && isTransactionType(raw.type) ? raw.type : "expense";
  const parsedCircle = parseCircleRef(raw.circle ?? undefined);
  return {
    type,
    circleId: parsedCircle?.id ?? null,
    // Preserve the raw param even when unparseable — dropping it here would let
    // canonicalize erase `hadUnparseableCircle` before Circles finish loading.
    circleRefParam: raw.circle,
    // The safe-origin codec owns validation: unsafe ≡ absent ≡ Home.
    returnTo: parseReturnTo(raw.returnTo, { fallback: "/" }),
    hadUnparseableCircle: raw.circle != null && parsedCircle === null,
    sourcePair: parseSourcePair(raw.sourceCircle, raw.sourceTransaction),
  };
}

export interface CanonicalGlobalAddUrlInput {
  type: TransactionType;
  /** Canonical Circle ref in the output; omit for the unselected shape. */
  circleRef?: string;
  /** Validated return origin; omitted from the output when it is the Home fallback. */
  returnTo?: string;
  /** Source Circle ref; emitted only with a paired Transaction ref. */
  sourceCircleRef?: string;
  /** Source Transaction ref; emitted only with a paired Circle ref. */
  sourceTransactionRef?: string;
}

/**
 * Builds the canonical URL from final values. Callers pass the PARSED state's
 * `returnTo` (already validated) and whichever Circle / source refs are correct
 * for their stage. Because output params are rebuilt from scratch, unknown and
 * duplicate parameters are dropped by construction. Non-Home `returnTo` merges
 * through the shared codec. Source params survive Type and destination Circle
 * rewrites when the caller re-supplies the pair.
 */
export function canonicalGlobalAddUrl({
  type,
  circleRef,
  returnTo,
  sourceCircleRef,
  sourceTransactionRef,
}: CanonicalGlobalAddUrlInput) {
  const params = new URLSearchParams({ [TYPE_PARAM]: type });
  if (circleRef) {
    params.set(CIRCLE_PARAM, circleRef);
  }
  appendSourcePairParams(params, sourceCircleRef, sourceTransactionRef);
  const base = withQuery(GLOBAL_ADD_PATH, params.toString());
  // An explicit Home origin adds nothing the fallback doesn't already provide.
  if (returnTo && returnTo !== "/") {
    return withReturnTo(base, returnTo);
  }
  return base;
}

/**
 * Source refs to re-pin on Type / Circle URL rewrites. Candidate pairs keep
 * their raw params (stale-slug canonicalize swaps them later); absent and
 * unusable pairs emit nothing so recovery can strip them.
 */
export function sourceRefsForRewrite(sourcePair: GlobalAddSourcePair) {
  if (sourcePair.kind !== "candidate") {
    return {};
  }
  return {
    sourceCircleRef: sourcePair.sourceCircleRefParam,
    sourceTransactionRef: sourcePair.sourceTransactionRefParam,
  };
}

/**
 * Recovers the source Detail's validated prior origin from Duplicate's
 * `returnTo` (the canonical source Detail rebuilt with that prior origin).
 * Never echoes an unsafe nested value; falls back to Home when the Detail
 * shape or nested origin cannot be recovered safely (issue #293/#299).
 */
export function recoverOriginFromSourceDetailReturn(returnTo: string) {
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) {
    return "/";
  }
  const queryStart = returnTo.indexOf("?");
  const pathname = queryStart === -1 ? returnTo : returnTo.slice(0, queryStart);
  // Canonical source Detail path: /circles/<ref>/transactions/<ref>
  if (!/^\/circles\/[^/]+\/transactions\/[^/]+$/.test(pathname)) {
    return "/";
  }
  const nested =
    queryStart === -1
      ? null
      : new URLSearchParams(returnTo.slice(queryStart + 1)).get(RETURN_TO_PARAM);
  return parseReturnTo(nested, { fallback: "/" });
}
