import { describe, expect, it } from "vitest";
import { parseReturnTo, RETURN_TO_PARAM, withReturnTo } from "./return-to-url.js";

const FALLBACK = "/circles/trip-c1/transactions";

describe("withReturnTo", () => {
  it("appends the origin as an encoded returnTo param", () => {
    const origin = "/circles/trip-c1/transactions?month=2026-05&type=expense";
    const href = withReturnTo("/circles/trip-c1/transactions/rent-t1", origin);
    // The whole origin (its own `?`/`&`/`=`) is encoded into a single param value.
    expect(href).toBe(
      `/circles/trip-c1/transactions/rent-t1?${RETURN_TO_PARAM}=${encodeURIComponent(origin)}`,
    );
    // Round-trips: reading the param back yields the original origin verbatim.
    const read = new URL(href, "http://t").searchParams.get(RETURN_TO_PARAM);
    expect(read).toBe(origin);
  });

  it("returns the bare path when no origin is given", () => {
    expect(withReturnTo("/circles/trip-c1/transactions/rent-t1")).toBe(
      "/circles/trip-c1/transactions/rent-t1",
    );
    expect(withReturnTo("/circles/trip-c1/transactions/rent-t1", "")).toBe(
      "/circles/trip-c1/transactions/rent-t1",
    );
  });
});

describe("parseReturnTo", () => {
  it.each([
    // [name, raw, expected]
    [
      "honors an in-Circle path, query preserved",
      "/circles/trip-c1/search?q=rent&page=2",
      "/circles/trip-c1/search?q=rent&page=2",
    ],
    ["honors the bare Circle root", "/circles/trip-c1", "/circles/trip-c1"],
    [
      "honors a nested encoded returnTo verbatim",
      "/circles/trip-c1/transactions/rent-t1?returnTo=%2Fcircles%2Ftrip-c1%2Fsearch",
      "/circles/trip-c1/transactions/rent-t1?returnTo=%2Fcircles%2Ftrip-c1%2Fsearch",
    ],
    [
      "honors an in-Circle path with a hash fragment",
      "/circles/trip-c1/transactions?month=2026-05#section",
      "/circles/trip-c1/transactions?month=2026-05#section",
    ],
    ["honors the bare Home path", "/", "/"],
    [
      "honors Home with query params (currency/range state)",
      "/?currency=CAD&range=6",
      "/?currency=CAD&range=6",
    ],
    ["honors Home with a hash fragment", "/#section", "/#section"],
    ["honors Home with query and hash", "/?currency=EUR&range=3#top", "/?currency=EUR&range=3#top"],
    ["honors the bare MCP authorize path", "/mcp/authorize", "/mcp/authorize"],
    [
      "honors MCP authorize with handoff query",
      "/mcp/authorize?handoff=payload.sig",
      "/mcp/authorize?handoff=payload.sig",
    ],
    [
      "honors MCP authorize with handoffId continuation",
      "/mcp/authorize?handoffId=abc",
      "/mcp/authorize?handoffId=abc",
    ],
  ])("%s", (_name, raw, expected) => {
    expect(parseReturnTo(raw, { fallback: FALLBACK })).toBe(expected);
  });

  it.each([
    ["null", null],
    ["empty string", ""],
    ["protocol-relative //evil.com", "//evil.com"],
    ["backslash variant /\\evil.com", "/\\evil.com"],
    ["backslash anywhere in path", "/circles/trip-c1\\@evil.com"],
    ["absolute cross-origin https", "https://evil.com"],
    ["absolute cross-origin http", "http://evil.com/circles/trip-c1"],
    ["a non-Circle top-level path", "/settings"],
    ["the Create Circle flow above the Circle guard", "/circles/new"],
    ["a percent-encoded Create Circle route", "/circles/%6e%65%77"],
    ["a percent-encoded Create Circle route with a child", "/circles/%6e%65%77/transactions"],
    ["a path that only looks like circles", "/circlesX/trip-c1"],
    ["circles with no ref", "/circles"],
    ["circles with an empty ref", "/circles//transactions"],
    ["a relative (non-absolute) path", "circles/trip-c1/transactions"],
    ["a tab control char", "/circles/trip-c1/\t/evil"],
    ["a newline control char", "/circles/trip-c1/\n/evil"],
    ["a NUL control char", "/circles/trip-c1/\0/evil"],
    ["a `..` traversal out of scope", "/circles/trip-c1/../settings"],
    ["a `..` traversal to another circle", "/circles/trip-c1/../../circles/other-c2"],
    // Percent-encoded dot segments: URLSearchParams hands these back undecoded, but the
    // browser collapses them to `..` while normalizing the path → must reject (PR #128 review).
    ["a fully encoded `%2e%2e` traversal", "/circles/trip-c1/%2e%2e/%2e%2e/settings"],
    ["an upper-case `%2E%2E` traversal", "/circles/trip-c1/%2E%2E/settings"],
    ["a mixed literal/encoded `.%2e` traversal", "/circles/trip-c1/.%2e/settings"],
    ["a mixed encoded/literal `%2e.` traversal", "/circles/trip-c1/%2e./settings"],
    ["an over-length value", `/circles/trip-c1/${"x".repeat(3000)}`],
    ["an over-length MCP authorize handoff", `/mcp/authorize?handoff=${"x".repeat(2100)}`],
  ])("falls back for %s", (_name, raw) => {
    expect(parseReturnTo(raw, { fallback: FALLBACK })).toBe(FALLBACK);
  });
});
