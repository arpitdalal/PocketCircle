import { describe, expect, it } from "vitest";
import {
  clampSearchPage,
  clampSearchPageSize,
  decodeSearchContinuation,
  encodeSearchContinuation,
  indexedSearchOffsetTakeLimit,
  searchContinuationBoundaryKey,
  searchContinuationFingerprint,
  searchOffsetTakeLimit,
  searchOffsetTotalCount,
  searchResultTotalPages,
  TRANSACTION_LIST_PAGE_SIZE,
  TRANSACTION_SEARCH_INDEXED_RESULT_CEILING,
  TRANSACTION_SEARCH_MAX_PAGE,
  TRANSACTION_SEARCH_MAX_PUBLIC_PAGE_SIZE,
} from "./transaction-search-pagination.js";

describe("transaction search pagination", () => {
  it("clamps page and page size to the public contract", () => {
    expect(clampSearchPageSize(undefined)).toBe(TRANSACTION_LIST_PAGE_SIZE);
    expect(clampSearchPageSize(Number.NaN)).toBe(TRANSACTION_LIST_PAGE_SIZE);
    expect(clampSearchPageSize(0)).toBe(1);
    expect(clampSearchPageSize(100)).toBe(TRANSACTION_SEARCH_MAX_PUBLIC_PAGE_SIZE);
    expect(clampSearchPageSize(250)).toBe(TRANSACTION_SEARCH_MAX_PUBLIC_PAGE_SIZE);

    expect(clampSearchPage(0)).toBe(1);
    expect(clampSearchPage(-3)).toBe(1);
    expect(clampSearchPage(99)).toBe(TRANSACTION_SEARCH_MAX_PAGE);
  });

  it("derives scan bounds from max page and indexed ceiling", () => {
    expect(searchOffsetTakeLimit(25)).toBe(TRANSACTION_SEARCH_MAX_PAGE * 25 + 1);
    expect(indexedSearchOffsetTakeLimit(25)).toBe(TRANSACTION_SEARCH_MAX_PAGE * 25 + 1);
    expect(indexedSearchOffsetTakeLimit(100)).toBe(TRANSACTION_SEARCH_INDEXED_RESULT_CEILING);
  });

  it("marks totals capped at the take sentinel or when more rows exist", () => {
    const takeLimit = searchOffsetTakeLimit(25);
    expect(searchOffsetTotalCount(10, takeLimit, false)).toEqual({
      totalCount: 10,
      totalCountCapped: false,
    });
    expect(searchOffsetTotalCount(takeLimit, takeLimit, false)).toEqual({
      totalCount: takeLimit,
      totalCountCapped: true,
    });
    expect(searchOffsetTotalCount(takeLimit, takeLimit)).toEqual({
      totalCount: takeLimit,
      totalCountCapped: true,
    });
    expect(searchOffsetTotalCount(5, takeLimit, true)).toEqual({
      totalCount: takeLimit,
      totalCountCapped: true,
    });
  });

  it("computes exposed page count from total count", () => {
    expect(searchResultTotalPages(0, 25)).toBe(0);
    expect(searchResultTotalPages(1, 25)).toBe(1);
    expect(searchResultTotalPages(25, 25)).toBe(1);
    expect(searchResultTotalPages(26, 25)).toBe(2);
    expect(searchResultTotalPages(searchOffsetTakeLimit(25), 25)).toBe(TRANSACTION_SEARCH_MAX_PAGE);
  });

  it("round-trips opaque search continuation tokens", () => {
    const withCursor = encodeSearchContinuation({
      v: 1,
      c: "engine-cursor",
      tc: 40,
      tcc: false,
      fp: "filters-v1",
    });
    expect(decodeSearchContinuation(withCursor)).toEqual({
      v: 1,
      c: "engine-cursor",
      tc: 40,
      tcc: false,
      fp: "filters-v1",
    });
    expect(searchContinuationBoundaryKey(withCursor)).toBe("filters-v1\0engine-cursor");
    expect(
      searchContinuationBoundaryKey(
        encodeSearchContinuation({
          v: 1,
          c: "engine-cursor",
          tc: 1001,
          tcc: true,
          fp: "filters-v1",
        }),
      ),
    ).toBe(searchContinuationBoundaryKey(withCursor));
    expect(decodeSearchContinuation("not-json")).toBeNull();
    expect(decodeSearchContinuation(JSON.stringify({ v: 1, tc: 1, tcc: false }))).toBeNull();
    expect(
      decodeSearchContinuation(
        JSON.stringify({ v: 1, c: "x", tc: 1, tcc: false /* missing fp */ }),
      ),
    ).toBeNull();
  });

  it("fingerprints query-defining search args stably", () => {
    const left = searchContinuationFingerprint({
      circleId: "c1",
      paidByMemberIds: ["b", "a"],
      recordedByMemberIds: [],
      categoryIds: ["y", "x"],
      queryText: "rent",
      pageSize: 25,
    });
    const right = searchContinuationFingerprint({
      circleId: "c1",
      paidByMemberIds: ["a", "b"],
      recordedByMemberIds: [],
      categoryIds: ["x", "y"],
      queryText: "rent",
      pageSize: 25,
    });
    expect(left).toBe(right);
    expect(
      searchContinuationFingerprint({
        circleId: "c2",
        paidByMemberIds: ["a", "b"],
        recordedByMemberIds: [],
        categoryIds: ["x", "y"],
        queryText: "rent",
        pageSize: 25,
      }),
    ).not.toBe(left);
  });
});
