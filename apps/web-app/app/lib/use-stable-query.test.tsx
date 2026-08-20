import { renderHook } from "@testing-library/react";
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
  it("keeps the previous value across an undefined gap without looping on new identities", () => {
    type Row = { incomeMinor: number };
    const { result, rerender } = renderHook(
      ({ row }: { row: Row | undefined }) => useRetainedQueryResult(row),
      { initialProps: { row: { incomeMinor: 100 } as Row | undefined } },
    );
    expect(result.current).toEqual({ value: { incomeMinor: 100 }, isPending: false });

    // Fresh object each time while defined — must not infinite-loop.
    rerender({ row: { incomeMinor: 100 } });
    expect(result.current.value).toEqual({ incomeMinor: 100 });
    expect(result.current.isPending).toBe(false);

    rerender({ row: undefined });
    expect(result.current).toEqual({ value: { incomeMinor: 100 }, isPending: true });

    rerender({ row: { incomeMinor: 200 } });
    expect(result.current).toEqual({ value: { incomeMinor: 200 }, isPending: false });
  });
});
