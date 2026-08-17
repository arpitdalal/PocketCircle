import { describe, expect, it } from "vitest";
import { canonicalHomeSummaryParams, readHomeSummarySelection } from "./home-summary-url.js";

describe("readHomeSummarySelection", () => {
  it("reads a valid currency and range", () => {
    const params = new URLSearchParams("currency=CAD&range=6");
    expect(readHomeSummarySelection(params)).toEqual({ currency: "CAD", range: 6 });
  });

  it("defaults to range 1 and undefined currency when params are absent", () => {
    expect(readHomeSummarySelection(new URLSearchParams())).toEqual({
      currency: undefined,
      range: 1,
    });
  });

  it("falls back to the default for an unsupported or malformed range", () => {
    expect(readHomeSummarySelection(new URLSearchParams("range=2")).range).toBe(1);
    expect(readHomeSummarySelection(new URLSearchParams("range=0")).range).toBe(1);
    expect(readHomeSummarySelection(new URLSearchParams("range=-6")).range).toBe(1);
    expect(readHomeSummarySelection(new URLSearchParams("range=banana")).range).toBe(1);
    expect(readHomeSummarySelection(new URLSearchParams("range=")).range).toBe(1);
  });

  it("treats an empty or whitespace-only currency as undefined", () => {
    expect(readHomeSummarySelection(new URLSearchParams("currency=")).currency).toBeUndefined();
    expect(readHomeSummarySelection(new URLSearchParams("currency=  ")).currency).toBeUndefined();
  });

  it("trims whitespace from currency", () => {
    expect(readHomeSummarySelection(new URLSearchParams("currency= USD ")).currency).toBe("USD");
  });
});

describe("canonicalHomeSummaryParams", () => {
  it("omits defaults so the canonical Home URL stays bare", () => {
    expect(canonicalHomeSummaryParams({ currency: undefined, range: 1 }).toString()).toBe("");
  });

  it("encodes a non-default selection", () => {
    const params = canonicalHomeSummaryParams({ currency: "CAD", range: 6 });
    expect(params.get("currency")).toBe("CAD");
    expect(params.get("range")).toBe("6");
  });

  it("preserves foreign params in their original order", () => {
    const preserve = new URLSearchParams("utm=x&ref=y");
    const params = canonicalHomeSummaryParams({ currency: "EUR", range: 3 }, preserve);
    const entries = [...params.entries()];
    // Foreign params first (in their order), then owned
    expect(entries[0]).toEqual(["utm", "x"]);
    expect(entries[1]).toEqual(["ref", "y"]);
    expect(entries[2]).toEqual(["currency", "EUR"]);
    expect(entries[3]).toEqual(["range", "3"]);
  });

  it("strips owned params from the preserve set (avoids duplicates)", () => {
    const preserve = new URLSearchParams("currency=OLD&range=12&utm=z");
    const params = canonicalHomeSummaryParams({ currency: "CAD", range: 3 }, preserve);
    expect(params.get("currency")).toBe("CAD");
    expect(params.get("range")).toBe("3");
    expect(params.get("utm")).toBe("z");
    // Only one currency/range value, not both
    expect(params.getAll("currency")).toHaveLength(1);
    expect(params.getAll("range")).toHaveLength(1);
  });

  it("round-trips through readHomeSummarySelection", () => {
    const selection = { currency: "EUR", range: 12 } as const;
    const roundTripped = readHomeSummarySelection(canonicalHomeSummaryParams(selection));
    expect(roundTripped).toEqual(selection);
  });
});
