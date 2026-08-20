import { describe, expect, it } from "vitest";
import { retainDefinedQueryResult } from "./use-stable-query.js";

describe("retainDefinedQueryResult", () => {
  it("returns undefined when there is no prior result and the query is still loading", () => {
    expect(retainDefinedQueryResult(undefined, undefined)).toBeUndefined();
  });

  it("keeps the previous result while the next args are loading", () => {
    expect(retainDefinedQueryResult(undefined, { incomeMinor: 100 })).toEqual({
      incomeMinor: 100,
    });
  });

  it("replaces previous with a freshly loaded result", () => {
    expect(retainDefinedQueryResult({ incomeMinor: 200 }, { incomeMinor: 100 })).toEqual({
      incomeMinor: 200,
    });
  });

  it("stores null (inaccessible) rather than treating it as loading", () => {
    expect(retainDefinedQueryResult(null, { incomeMinor: 100 })).toBeNull();
    expect(retainDefinedQueryResult(undefined, null)).toBeNull();
  });
});
