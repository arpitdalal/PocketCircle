import { describe, expect, it } from "vitest";
import {
  canonicalGlobalAddUrl,
  GLOBAL_ADD_PATH,
  globalAddHref,
  parseGlobalAddParams,
  readGlobalAddParams,
  recoverOriginFromSourceDetailReturn,
  sourceRefsForRewrite,
} from "./global-add-url.js";

/**
 * Pure contract tests for the Global Add URL codec (issues #298/#299): the
 * canonical builder, the raw reader, normalization (missing/malformed Type,
 * raw ids, stale refs, unparseable Circles), Duplicate source-pair rules,
 * unavailable-source return recovery, unknown/duplicate parameter removal,
 * safe-return derivation, and canonical output shape.
 */

const HOME_ORIGIN = "/?currency=CAD&range=3";
const SOURCE_DETAIL = "/circles/trip-c1/transactions/weekly-shop-t1";
const SOURCE_DETAIL_WITH_ORIGIN = `${SOURCE_DETAIL}?returnTo=${encodeURIComponent("/circles/trip-c1/transactions?month=2026-05")}`;

function parseQuery(query: string) {
  return parseGlobalAddParams(readGlobalAddParams(new URLSearchParams(query)));
}

describe("globalAddHref", () => {
  it("builds the canonical bare shape with type only", () => {
    expect(globalAddHref({ type: "expense" })).toBe(`${GLOBAL_ADD_PATH}?type=expense`);
  });

  it("carries circle ref and returnTo when given", () => {
    expect(globalAddHref({ type: "income", circleRef: "trip-c1", returnTo: "/" })).toBe(
      `${GLOBAL_ADD_PATH}?type=income&circle=trip-c1&returnTo=%2F`,
    );
  });

  it("emits source params only as a complete pair", () => {
    expect(
      globalAddHref({
        type: "expense",
        circleRef: "trip-c1",
        sourceCircleRef: "trip-c1",
        sourceTransactionRef: "weekly-shop-t1",
        returnTo: SOURCE_DETAIL_WITH_ORIGIN,
      }),
    ).toBe(
      `${GLOBAL_ADD_PATH}?type=expense&circle=trip-c1&sourceCircle=trip-c1&sourceTransaction=weekly-shop-t1&returnTo=${encodeURIComponent(SOURCE_DETAIL_WITH_ORIGIN)}`,
    );
  });

  it("omits a partial source pair from the built URL", () => {
    expect(
      globalAddHref({
        type: "expense",
        sourceCircleRef: "trip-c1",
      }),
    ).toBe(`${GLOBAL_ADD_PATH}?type=expense`);
  });
});

describe("parseGlobalAddParams — type", () => {
  it("keeps a valid expense type", () => {
    expect(parseQuery("type=expense").type).toBe("expense");
  });

  it("keeps a valid income type", () => {
    expect(parseQuery("type=income").type).toBe("income");
  });

  it("normalizes a missing type to expense", () => {
    expect(parseQuery("").type).toBe("expense");
  });

  it("normalizes a malformed type to expense without keeping the raw value", () => {
    const state = parseQuery("type=nonsense");
    expect(state.type).toBe("expense");
    expect(canonicalGlobalAddUrl({ type: state.type, returnTo: state.returnTo })).toBe(
      `${GLOBAL_ADD_PATH}?type=expense`,
    );
  });
});

describe("parseGlobalAddParams — circle", () => {
  it("parses a canonical slug-id ref to its authoritative id", () => {
    const state = parseQuery("circle=shared-home-c123");
    expect(state.circleId).toBe("c123");
    expect(state.circleRefParam).toBe("shared-home-c123");
    expect(state.hadUnparseableCircle).toBe(false);
  });

  it("accepts a bare raw id as the ref param", () => {
    const state = parseQuery("circle=c123");
    expect(state.circleId).toBe("c123");
    expect(state.circleRefParam).toBe("c123");
  });

  it("treats an absent circle as the valid unselected state", () => {
    const state = parseQuery("type=expense");
    expect(state.circleId).toBeNull();
    expect(state.circleRefParam).toBeNull();
    expect(state.hadUnparseableCircle).toBe(false);
  });

  it("flags an unparseable circle value for generic feedback while clearing the id", () => {
    const state = parseQuery("circle=not-a-ref!");
    expect(state.circleId).toBeNull();
    expect(state.circleRefParam).toBe("not-a-ref!");
    expect(state.hadUnparseableCircle).toBe(true);
  });

  it("keeps an unparseable circle in the canonical URL until the route strips it", () => {
    const state = parseQuery("type=expense&circle=not-a-ref!");
    expect(
      canonicalGlobalAddUrl({
        type: state.type,
        circleRef: state.circleRefParam ?? undefined,
        returnTo: state.returnTo,
      }),
    ).toBe(`${GLOBAL_ADD_PATH}?type=expense&circle=not-a-ref%21`);
  });
});

describe("parseGlobalAddParams — source pair", () => {
  it("treats both source params absent as ordinary Global Add", () => {
    expect(parseQuery("type=expense").sourcePair).toEqual({ kind: "absent" });
  });

  it("accepts a usable candidate pair with authoritative ids", () => {
    expect(parseQuery("sourceCircle=trip-c1&sourceTransaction=weekly-shop-t1").sourcePair).toEqual({
      kind: "candidate",
      sourceCircleId: "c1",
      sourceCircleRefParam: "trip-c1",
      sourceTransactionId: "t1",
      sourceTransactionRefParam: "weekly-shop-t1",
    });
  });

  it("accepts raw ids as a usable candidate pair", () => {
    expect(parseQuery("sourceCircle=c1&sourceTransaction=t1").sourcePair).toEqual({
      kind: "candidate",
      sourceCircleId: "c1",
      sourceCircleRefParam: "c1",
      sourceTransactionId: "t1",
      sourceTransactionRefParam: "t1",
    });
  });

  it("treats a partial pair as unusable", () => {
    expect(parseQuery("sourceCircle=trip-c1").sourcePair).toEqual({ kind: "unusable" });
    expect(parseQuery("sourceTransaction=weekly-shop-t1").sourcePair).toEqual({
      kind: "unusable",
    });
  });

  it("treats a malformed source ref as unusable", () => {
    expect(parseQuery("sourceCircle=bad!&sourceTransaction=weekly-shop-t1").sourcePair).toEqual({
      kind: "unusable",
    });
    expect(parseQuery("sourceCircle=trip-c1&sourceTransaction=bad!").sourcePair).toEqual({
      kind: "unusable",
    });
  });

  it("treats duplicate source parameters as unusable", () => {
    expect(
      parseQuery("sourceCircle=trip-c1&sourceCircle=cabin-c2&sourceTransaction=weekly-shop-t1")
        .sourcePair,
    ).toEqual({ kind: "unusable" });
    expect(
      parseQuery("sourceCircle=trip-c1&sourceTransaction=weekly-shop-t1&sourceTransaction=rent-t2")
        .sourcePair,
    ).toEqual({ kind: "unusable" });
    expect(
      parseQuery(
        "sourceCircle=trip-c1&sourceCircle=cabin-c2&sourceTransaction=weekly-shop-t1&sourceTransaction=rent-t2",
      ).sourcePair,
    ).toEqual({ kind: "unusable" });
  });

  it("preserves candidate source refs across Type and Circle rewrites", () => {
    const state = parseQuery(
      "type=expense&circle=trip-c1&sourceCircle=trip-c1&sourceTransaction=weekly-shop-t1&returnTo=%2F",
    );
    expect(
      canonicalGlobalAddUrl({
        type: "income",
        circleRef: "cabin-c2",
        returnTo: state.returnTo,
        ...sourceRefsForRewrite(state.sourcePair),
      }),
    ).toBe(
      `${GLOBAL_ADD_PATH}?type=income&circle=cabin-c2&sourceCircle=trip-c1&sourceTransaction=weekly-shop-t1`,
    );
  });

  it("drops source refs for absent and unusable pairs on rewrite", () => {
    expect(sourceRefsForRewrite({ kind: "absent" })).toEqual({});
    expect(sourceRefsForRewrite({ kind: "unusable" })).toEqual({});
  });
});

describe("parseGlobalAddParams — returnTo", () => {
  it("keeps a safe Home origin with its query state", () => {
    expect(parseQuery(`returnTo=${encodeURIComponent(HOME_ORIGIN)}`).returnTo).toBe(HOME_ORIGIN);
  });

  it("keeps a safe in-Circle origin", () => {
    expect(
      parseQuery(`returnTo=${encodeURIComponent("/circles/trip-c1/transactions")}`).returnTo,
    ).toBe("/circles/trip-c1/transactions");
  });

  it("falls back to Home when missing", () => {
    expect(parseQuery("").returnTo).toBe("/");
  });

  it("falls back to Home for an unsafe off-origin value", () => {
    expect(parseQuery(`returnTo=${encodeURIComponent("https://evil.com")}`).returnTo).toBe("/");
  });

  it("falls back to Home for a protocol-relative value", () => {
    expect(parseQuery(`returnTo=${encodeURIComponent("//evil.com")}`).returnTo).toBe("/");
  });
});

describe("recoverOriginFromSourceDetailReturn", () => {
  it("extracts the validated prior origin from a canonical source Detail returnTo", () => {
    expect(recoverOriginFromSourceDetailReturn(SOURCE_DETAIL_WITH_ORIGIN)).toBe(
      "/circles/trip-c1/transactions?month=2026-05",
    );
  });

  it("falls back to Home when the Detail has no nested origin", () => {
    expect(recoverOriginFromSourceDetailReturn(SOURCE_DETAIL)).toBe("/");
  });

  it("falls back to Home for a non-Detail returnTo", () => {
    expect(recoverOriginFromSourceDetailReturn(HOME_ORIGIN)).toBe("/");
    expect(recoverOriginFromSourceDetailReturn("/circles/trip-c1/transactions")).toBe("/");
  });

  it("falls back to Home for an unsafe nested origin", () => {
    expect(
      recoverOriginFromSourceDetailReturn(
        `${SOURCE_DETAIL}?returnTo=${encodeURIComponent("//evil.com")}`,
      ),
    ).toBe("/");
  });
});

describe("canonicalGlobalAddUrl", () => {
  it("emits the full canonical shape with all values present", () => {
    expect(
      canonicalGlobalAddUrl({ type: "income", circleRef: "trip-c1", returnTo: HOME_ORIGIN }),
    ).toBe(
      `${GLOBAL_ADD_PATH}?type=income&circle=trip-c1&returnTo=${encodeURIComponent(HOME_ORIGIN)}`,
    );
  });

  it("omits the circle for the unselected shape", () => {
    expect(canonicalGlobalAddUrl({ type: "expense" })).toBe(`${GLOBAL_ADD_PATH}?type=expense`);
  });

  it("omits a Home-fallback return origin", () => {
    expect(canonicalGlobalAddUrl({ type: "expense", returnTo: "/" })).toBe(
      `${GLOBAL_ADD_PATH}?type=expense`,
    );
  });

  it("drops unknown and duplicate parameters by rebuilding from parsed state", () => {
    // `month` is not a Global Add parameter; `type` appears twice (first wins).
    const raw = readGlobalAddParams(new URLSearchParams("?type=income&type=expense&month=2026-05"));
    expect(
      canonicalGlobalAddUrl({
        type: parseGlobalAddParams(raw).type,
        returnTo: parseGlobalAddParams(raw).returnTo,
      }),
    ).toBe(`${GLOBAL_ADD_PATH}?type=income`);
  });

  it("round-trips a built Duplicate URL to itself after parsing", () => {
    const url = globalAddHref({
      type: "expense",
      circleRef: "home-c9",
      sourceCircleRef: "home-c9",
      sourceTransactionRef: "rent-t2",
      returnTo: SOURCE_DETAIL_WITH_ORIGIN,
    });
    const query = url.slice(url.indexOf("?") + 1);
    const state = parseGlobalAddParams(readGlobalAddParams(new URLSearchParams(query)));
    expect(
      canonicalGlobalAddUrl({
        type: state.type,
        circleRef: state.circleRefParam ?? undefined,
        returnTo: state.returnTo,
        ...sourceRefsForRewrite(state.sourcePair),
      }),
    ).toBe(url);
  });
});
