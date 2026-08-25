import { describe, expect, it } from "vitest";
import {
  canonicalGlobalAddUrl,
  GLOBAL_ADD_PATH,
  globalAddHref,
  parseGlobalAddParams,
  readGlobalAddParams,
} from "./global-add-url.js";

/**
 * Pure contract tests for the ordinary Global Add URL codec (issue #298): the
 * canonical builder, the raw reader, normalization (missing/malformed Type,
 * raw ids, stale refs, unparseable Circles), unknown/duplicate parameter
 * removal, safe-return derivation, and canonical output shape. No router, no
 * React — this is the same module the route and every link builder call.
 */

const HOME_ORIGIN = "/?currency=CAD&range=3";

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
    expect(canonicalGlobalAddUrl(parseGlobalAddParams(raw))).toBe(`${GLOBAL_ADD_PATH}?type=income`);
  });

  it("round-trips a built URL to itself after parsing", () => {
    const url = globalAddHref({ type: "expense", circleRef: "home-c9", returnTo: HOME_ORIGIN });
    const query = url.slice(url.indexOf("?") + 1);
    const state = parseGlobalAddParams(readGlobalAddParams(new URLSearchParams(query)));
    expect(canonicalGlobalAddUrl({ ...state, circleRef: state.circleRefParam ?? undefined })).toBe(
      url,
    );
  });
});
