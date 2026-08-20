import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { retainDefinedQueryResult, useRetainedQueryResult } from "./use-stable-query.js";

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

describe("useRetainedQueryResult", () => {
  it("keeps the previous value across an undefined gap and tracks live updates", () => {
    type Row = { incomeMinor: number };
    let row: Row | undefined = { incomeMinor: 100 };
    const { result, rerender } = renderHook(() => useRetainedQueryResult(row));
    expect(result.current).toEqual({ value: { incomeMinor: 100 }, isPending: false });

    row = { incomeMinor: 150 };
    rerender();
    expect(result.current).toEqual({ value: { incomeMinor: 150 }, isPending: false });

    row = undefined;
    rerender();
    expect(result.current).toEqual({ value: { incomeMinor: 150 }, isPending: true });

    row = { incomeMinor: 200 };
    rerender();
    expect(result.current).toEqual({ value: { incomeMinor: 200 }, isPending: false });
  });

  it("clears the retained bridge when resetKey changes", () => {
    type Row = { incomeMinor: number };
    let row: Row | undefined = { incomeMinor: 100 };
    let resetKey = "circle-a";
    const { result, rerender } = renderHook(() => useRetainedQueryResult(row, { resetKey }));
    expect(result.current.value).toEqual({ incomeMinor: 100 });

    row = undefined;
    resetKey = "circle-b";
    act(() => {
      rerender();
    });
    expect(result.current).toEqual({ value: undefined, isPending: false });
  });
});
