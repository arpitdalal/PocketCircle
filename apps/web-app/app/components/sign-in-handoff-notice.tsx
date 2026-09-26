import { useConvexAuth } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { useSnackbar } from "~/lib/snackbar.js";

/**
 * Query param the cross-domain sign-in handoff lands with. The cross-domain client
 * keeps the session in origin-scoped `localStorage` and redeems this one-time token
 * to get it (#409).
 */
const HANDOFF_PARAM = "ott";

/**
 * How long the redemption is given before a still-signed-out User is told about it.
 * The token itself lives three minutes and is spent by the first redemption attempt,
 * so there is nothing to gain by waiting long: past this point the handoff either
 * landed or is not going to, and the honest move is to say so and let the User sign
 * in again. Generous relative to the redemption itself — two round trips to the auth
 * deployment — because a spurious report on a sign-in that then succeeds is worse
 * than a late one.
 */
const HANDOFF_SETTLE_MS = 10_000;

/**
 * Whether the URL says a cross-domain sign-in handoff is in flight. Same predicate
 * the provider uses to decide whether to redeem, so the two never disagree about
 * whether a handoff was started at all.
 */
function handoffInFlight() {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean(new URL(window.location.href).searchParams.get(HANDOFF_PARAM));
}

/**
 * Tells a User whose cross-domain sign-in handoff did not complete.
 *
 * The redemption itself belongs to `ConvexBetterAuthProvider`, which does it with no
 * error path: it strips the token from the URL before the request and reports nothing
 * when the request fails or arrives after the token expired, so the User is dropped
 * back at sign-in with a spent token and no explanation. That step is the vendor's to
 * own, so this does not retry it — the token is unrecoverable either way. It supplies
 * the missing half: a diagnosis, and the sign-in button beside it as the way forward.
 */
export function SignInHandoffNotice() {
  const { show } = useSnackbar();
  const { isAuthenticated, isLoading } = useConvexAuth();
  // Read during the first render on purpose: the provider removes the param in an
  // effect, so anything read later would see a URL with no sign-in in it.
  const [started] = useState(handoffInFlight);
  const [deadlineReached, setDeadlineReached] = useState(false);
  // The handoff's outcome is decided once: a session that lands ends the question,
  // and a User signing out later is not a handoff that failed. This notice is
  // mounted app-wide, so without that it would report the first sign-out of the
  // session, whenever it happened to fall after the deadline.
  const outcomeRef = useRef<"pending" | "landed" | "reported">("pending");

  useEffect(() => {
    if (!started) {
      return;
    }
    const timeoutId = window.setTimeout(() => setDeadlineReached(true), HANDOFF_SETTLE_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [started]);

  useEffect(() => {
    if (isAuthenticated) {
      outcomeRef.current = "landed";
    }
  }, [isAuthenticated]);

  useEffect(() => {
    // One deadline, not a sliding window: a session that refetches more often than
    // the timeout must not postpone the report for as long as it keeps doing that.
    // A session still resolving at the deadline defers it — a slow session is not a
    // failed sign-in — and the report follows as soon as it settles signed out.
    if (outcomeRef.current !== "pending" || !deadlineReached || isLoading || isAuthenticated) {
      return;
    }
    outcomeRef.current = "reported";
    show("Couldn't finish signing in. Try again.");
  }, [deadlineReached, isAuthenticated, isLoading, show]);

  return null;
}
