import { api } from "@pocketcircle/convex";
import { useConvexAuth, useQuery } from "convex/react";
import { useParams } from "react-router";
import type { Circle } from "./data.js";
import { MOCKS } from "./env.js";
import { mockResolvedCircle } from "./fixtures.js";
import { parseCircleRef } from "./refs.js";
import { type Resolution, useResolvedRef } from "./use-resolved-ref.js";

export type { Circle };

/**
 * The Circle adapter over the shared resolution primitive (ADR 0016/0017): read
 * `circleRef`, parse it, subscribe by id (synthesizing in mock mode), then hand
 * `parsed` + `value` to {@link useResolvedRef}, which owns the pending /
 * canonicalize / fall-back state machine. The upcoming object guards
 * (transactions/:transactionRef, categories/:categoryRef) are the same adapter
 * shape, additionally reading the resolved Circle from Outlet context (useCircle)
 * for their Circle-scoped query args and a Circle-route fallback.
 *
 * The fallback for an inaccessible Circle is the User's default safe route ("/").
 * Because resolution is staged, an inaccessible Circle means object guards never
 * mount, so object existence cannot leak.
 */
export function useResolvedCircle(fallback = "/"): Resolution<Circle> {
  const { circleRef } = useParams();
  const { isAuthenticated } = useConvexAuth();

  const parsed = parseCircleRef(circleRef);
  const queried = useQuery(
    api.circles.getCircle,
    parsed && !MOCKS && isAuthenticated ? { circleId: parsed.id } : "skip",
  );
  // Mock mode synthesizes a setup-complete Circle so fixture-backed routes render
  // offline without hitting the mandatory-setup gate (ADR 0006).
  const value = MOCKS && parsed ? mockResolvedCircle(parsed.id) : queried;

  return useResolvedRef<Circle>({
    rawRef: circleRef,
    parsed: parsed != null,
    value,
    fallback,
    // A Circle-flavored unavailable message reads correctly for a Member removed
    // mid-session (they didn't click a "link"); still anti-enumeration-safe since
    // missing and inaccessible Circles both resolve to `null` (ADR 0016).
    unavailableTarget: "circle",
  });
}
