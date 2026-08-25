import { isTransactionType, type TransactionType } from "@pocketcircle/domain";
import { withQuery } from "./ledger-url.js";
import { parseCircleRef } from "./refs.js";
import { parseReturnTo, RETURN_TO_PARAM, withReturnTo } from "./return-to-url.js";

/**
 * The one URL codec for ordinary Global Add (issue #298, ADR 0016/0017): the
 * canonical builder, parser, and normalizer for the protected top-level
 * `/transactions/new` route. It owns every rule about which parameters the
 * route recognizes (`type`, `circle`, `returnTo`), how a raw value becomes
 * trusted state, and what the canonical URL for that state looks like — so no
 * link, guard, or test can drift from the contract.
 *
 * Normalization rules (issue #290):
 *  - Missing or malformed `type` normalizes to `expense`.
 *  - `circle` is the canonical `slug-id` Circle ref; it parses to its
 *    authoritative id (raw ids and stale slugs both resolve by id). An absent
 *    param is a valid unselected state; an UNPARSEABLE one is flagged so the
 *    route can fire the generic unavailable feedback.
 *  - `returnTo` reuses the app-wide safe-origin codec; anything unsafe falls
 *    back to Home (`/`) and is indistinguishable from absent.
 *  - Unknown and duplicate parameters simply never reach the canonical output —
 *    rebuilding the query from parsed state drops them.
 */

export const GLOBAL_ADD_PATH = "/transactions/new";

const TYPE_PARAM = "type";
const CIRCLE_PARAM = "circle";

export interface GlobalAddHrefInput {
  type: TransactionType;
  /** Canonical Circle ref to select on open; omit for an unselected page. */
  circleRef?: string;
  /** Validated return origin (see `withReturnTo`); omit to fall back to Home. */
  returnTo?: string;
}

/**
 * Canonical Global Add URL builder — the single home every caller (Home's
 * primary action, the Activation Checklist, tests) builds the create link
 * through, so the path and parameter names can't drift. Optional `returnTo`
 * merges through the shared `withReturnTo` codec (callers that already wrap
 * the result may omit it).
 */
export function globalAddHref({ type, circleRef, returnTo }: GlobalAddHrefInput) {
  const params = new URLSearchParams({ [TYPE_PARAM]: type });
  if (circleRef) {
    params.set(CIRCLE_PARAM, circleRef);
  }
  return withReturnTo(withQuery(GLOBAL_ADD_PATH, params.toString()), returnTo);
}

/** The raw query values exactly as the URL carried them (first duplicate wins). */
export interface RawGlobalAddParams {
  type: string | null;
  circle: string | null;
  returnTo: string | null;
}

export function readGlobalAddParams(searchParams: URLSearchParams) {
  return {
    type: searchParams.get(TYPE_PARAM),
    circle: searchParams.get(CIRCLE_PARAM),
    returnTo: searchParams.get(RETURN_TO_PARAM),
  };
}

/**
 * The trusted URL-owned state after normalization. This is everything the route
 * derives from the address bar; draft fields deliberately live only in form
 * memory (issue #298).
 */
export interface GlobalAddUrlState {
  type: TransactionType;
  /** Authoritative Circle id from the `circle` param; null when absent/unparseable. */
  circleId: string | null;
  /**
   * The raw param as carried, kept ONLY while it still matches the resolved
   * Circle's canonical ref — the stale-slug comparison input. Null when absent
   * or unparseable.
   */
  circleRefParam: string | null;
  /** Validated return origin; Home when missing/unsafe. */
  returnTo: string;
  /** A `circle` param was present but did not parse — generic-feedback-worthy. */
  hadUnparseableCircle: boolean;
}

export function parseGlobalAddParams(raw: RawGlobalAddParams) {
  const type = raw.type != null && isTransactionType(raw.type) ? raw.type : "expense";
  const parsedCircle = parseCircleRef(raw.circle ?? undefined);
  return {
    type,
    circleId: parsedCircle?.id ?? null,
    circleRefParam: parsedCircle ? (raw.circle ?? null) : null,
    // The safe-origin codec owns validation: unsafe ≡ absent ≡ Home.
    returnTo: parseReturnTo(raw.returnTo, { fallback: "/" }),
    hadUnparseableCircle: raw.circle != null && parsedCircle === null,
  };
}

export interface CanonicalGlobalAddUrlInput {
  type: TransactionType;
  /** Canonical Circle ref in the output; omit for the unselected shape. */
  circleRef?: string;
  /** Validated return origin; omitted from the output when it is the Home fallback. */
  returnTo?: string;
}

/**
 * Builds the canonical URL from final values. Callers pass the PARSED state's
 * `returnTo` (already validated) and whichever Circle ref is correct for their
 * stage: the raw param before resolution completes, the resolved canonical ref
 * after, or nothing once the Circle is cleared. Because output params are
 * rebuilt from scratch, unknown and duplicate parameters are dropped by
 * construction. Non-Home `returnTo` merges through the shared codec.
 */
export function canonicalGlobalAddUrl({ type, circleRef, returnTo }: CanonicalGlobalAddUrlInput) {
  const params = new URLSearchParams({ [TYPE_PARAM]: type });
  if (circleRef) {
    params.set(CIRCLE_PARAM, circleRef);
  }
  const base = withQuery(GLOBAL_ADD_PATH, params.toString());
  // An explicit Home origin adds nothing the fallback doesn't already provide.
  if (returnTo && returnTo !== "/") {
    return withReturnTo(base, returnTo);
  }
  return base;
}
