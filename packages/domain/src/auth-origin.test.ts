import { describe, expect, it } from "vitest";
import { classifyAuthOrigin, describeAuthOriginFailure } from "./auth-origin.js";
import { APEX_ORIGIN, APP_ORIGIN, isDeclaredOrigin, LOCAL_APP_ORIGIN } from "./origins.js";

/** What `convex env get SITE_URL` prints for a deployment storing `stored`. */
function cliRead(stored: string, { status = 0, stderr = "" } = {}) {
  return { stdout: stored === "" ? "" : `${stored}\n`, stderr, status };
}

/** Every shape this gate could be handed, well-formed and not. */
const MATRIX = [
  APP_ORIGIN,
  APEX_ORIGIN,
  LOCAL_APP_ORIGIN,
  `${APP_ORIGIN} `,
  ` ${APP_ORIGIN}`,
  `${APP_ORIGIN}\n`,
  `${APP_ORIGIN}\r`,
  `${APP_ORIGIN}\r\n`,
  `\t${APP_ORIGIN}`,
  "https://*.example.com",
  "app.example.com",
  "https://a.example.com,https://b.example.com",
  "https://app.example.com/signin",
  "https://app.example.com@evil.example",
  "https://ex%41mple.com",
  "https://evil.example\\app.example.com",
  "http://app.example.com",
  "",
];

describe("the bytes the gate reads", () => {
  /** The stored value as the gate reports it, which is verbatim or not at all. */
  function storedValue(stdout: string) {
    const verdict = classifyAuthOrigin({ stdout, stderr: "", status: 0 }, APP_ORIGIN);
    // Both the accepted and the refused arm report the value in full, so this is the
    // stored bytes verbatim whichever way the verdict went.
    if (verdict.kind === "ok" || verdict.kind === "wrong") {
      return verdict.siteUrl;
    }
    throw new Error(`expected a value, got ${verdict.kind}`);
  }

  it("removes the CLI's own newline and nothing else", () => {
    // The whole point: a stored value carrying its own trailing newline must survive,
    // because the backend refuses it and a gate that tidied it away would approve a
    // release that takes sign-in down.
    expect(storedValue(`${APP_ORIGIN}\n`)).toBe(APP_ORIGIN);
    expect(storedValue(`${APP_ORIGIN}\n\n`)).toBe(`${APP_ORIGIN}\n`);
  });

  it("leaves a value the CLI printed without a newline alone", () => {
    expect(storedValue(APP_ORIGIN)).toBe(APP_ORIGIN);
  });

  it("preserves every byte the deployment stored, whatever it is", () => {
    for (const stored of [
      `${APP_ORIGIN} `,
      ` ${APP_ORIGIN}`,
      `${APP_ORIGIN}\t`,
      `${APP_ORIGIN}\r`,
      `${APP_ORIGIN}\r\n`,
    ]) {
      expect(storedValue(`${stored}\n`)).toBe(stored);
    }
  });
});

describe("classifyAuthOrigin", () => {
  it("accepts the declared origin", () => {
    expect(classifyAuthOrigin(cliRead(APP_ORIGIN), APP_ORIGIN)).toEqual({
      kind: "ok",
      siteUrl: APP_ORIGIN,
    });
  });

  it("rejects a value the product Worker does not serve", () => {
    expect(classifyAuthOrigin(cliRead(APEX_ORIGIN), APP_ORIGIN)).toEqual({
      kind: "wrong",
      siteUrl: APEX_ORIGIN,
    });
  });

  // Every one of these is a value the backend's `declaredOrigin` refuses, so a gate that
  // accepts any of them approves a release whose auth is down on the value it validated.
  // Each was a real bug in a previous version of this check.
  it.each([
    ["a trailing space", `${APP_ORIGIN} `],
    ["a leading space", ` ${APP_ORIGIN}`],
    ["a trailing newline", `${APP_ORIGIN}\n`],
    ["a trailing carriage return", `${APP_ORIGIN}\r`],
    ["a trailing CRLF", `${APP_ORIGIN}\r\n`],
    ["a leading tab", `\t${APP_ORIGIN}`],
  ])("rejects %s rather than normalising it away", (_label, stored) => {
    expect(classifyAuthOrigin(cliRead(stored), APP_ORIGIN)).toEqual({
      kind: "wrong",
      siteUrl: stored,
    });
  });

  it("reports an absent variable as unset, not as a wrong value", () => {
    // `convex env get` exits 0 for a variable that is not set, so only the empty stdout
    // distinguishes this — and telling an operator their value is wrong when they have
    // none sends them to fix the wrong thing.
    expect(
      classifyAuthOrigin(
        { stdout: "", stderr: '✖ Environment variable "SITE_URL" not found', status: 0 },
        APP_ORIGIN,
      ),
    ).toEqual({ kind: "unset" });
  });

  it("reports a transport failure as unreachable, carrying the CLI's own words", () => {
    expect(
      classifyAuthOrigin({ stdout: "", stderr: "✖ connection refused", status: 1 }, APP_ORIGIN),
    ).toEqual({ kind: "unreachable", status: 1, detail: "✖ connection refused" });
  });

  it("refuses a failed read even when it managed to print the right value", () => {
    // A command interrupted after flushing stdout has failed, and its output is not a
    // result. Accepting it because the bytes look right is how a release ships on a
    // configuration nobody successfully read — and it is the one case where the old
    // empty-stdout condition let a definitive failure through.
    expect(
      classifyAuthOrigin(
        { stdout: `${APP_ORIGIN}\n`, stderr: "✖ interrupted", status: 1 },
        APP_ORIGIN,
      ),
    ).toEqual({ kind: "unreachable", status: 1, detail: "✖ interrupted" });
  });

  it("treats every non-zero status as a failure, since not-set exits zero", () => {
    // `convex env get` reports an absent variable on stderr and still exits 0, so there is
    // no non-zero status that is a legitimate answer — not even one that says "not found".
    for (const stderr of ["✖ not found", "✖ connection refused", ""]) {
      expect(classifyAuthOrigin({ stdout: "", stderr, status: 2 }, APP_ORIGIN).kind).toBe(
        "unreachable",
      );
    }
  });

  it("ignores stderr noise on a successful read", () => {
    // The CLI writes progress to stderr. Merging it into the value fails a correct
    // configuration for a reason no message could name.
    expect(
      classifyAuthOrigin(
        { stdout: `${APP_ORIGIN}\n`, stderr: "Progress: resolved 1, reused 1", status: 0 },
        APP_ORIGIN,
      ),
    ).toEqual({ kind: "ok", siteUrl: APP_ORIGIN });
  });

  it("is not fooled by a value that merely looks like the expected one", () => {
    // A stricter `expected` must not smuggle a shape past the gate: the deployment is
    // compared against, not fitted to, the value it reports.
    expect(classifyAuthOrigin(cliRead(APP_ORIGIN), `${APP_ORIGIN} `)).toEqual({
      kind: "wrong",
      siteUrl: APP_ORIGIN,
    });
  });
});

// The gate and the backend must never disagree about the one value they share: the
// expected origin. They cannot call one function — this module is loaded by plain Node,
// which cannot resolve the package's `.js`-for-`.ts` specifiers — so the coupling is
// asserted here instead.
//
// Note what is deliberately *not* asserted: that the two accept the same set of values.
// The gate accepts only `value === expected`, so that property holds for any `expected` at
// all and would pass even if the backend's rule were deleted — it guards nothing. The
// invariant with teeth is below.
describe("the expected origin is one the backend accepts", () => {
  it("APP_ORIGIN is a bare origin, so the gate compares against something auth trusts", () => {
    // If this fails, the backend would throw on every auth request while the gate
    // cheerfully approved the same value as correct — the one way the two can be wrong
    // about the same origin at the same time.
    expect(isDeclaredOrigin(APP_ORIGIN)).toBe(true);
  });

  it("and the gate approves exactly that value and nothing else", () => {
    // The gate's whole strictness is `===` on bytes it does not normalise, so a value the
    // backend refuses can never be approved however it is spelled.
    for (const value of MATRIX.filter((v) => v !== APP_ORIGIN)) {
      expect(classifyAuthOrigin(cliRead(value), APP_ORIGIN).kind).not.toBe("ok");
    }
    expect(classifyAuthOrigin(cliRead(APP_ORIGIN), APP_ORIGIN).kind).toBe("ok");
  });
});

describe("describeAuthOriginFailure", () => {
  it("says nothing when the origin is right", () => {
    expect(
      describeAuthOriginFailure({ kind: "ok", siteUrl: APP_ORIGIN }, APP_ORIGIN),
    ).toBeUndefined();
  });

  it("names the value and the fix for each way of being wrong", () => {
    expect(describeAuthOriginFailure({ kind: "unset" }, APP_ORIGIN)).toContain("is not set");
    expect(describeAuthOriginFailure({ kind: "unset" }, APP_ORIGIN)).toContain(APP_ORIGIN);
    expect(
      describeAuthOriginFailure({ kind: "wrong", siteUrl: APEX_ORIGIN }, APP_ORIGIN),
    ).toContain(`'${APEX_ORIGIN}'`);
    expect(
      describeAuthOriginFailure({ kind: "unreachable", status: 1, detail: "boom" }, APP_ORIGIN),
    ).toContain("will not guess");
  });

  it("reports a whitespace-bearing value exactly as configured, not tidied", () => {
    // The message is the only thing an operator sees, so a tidied value here would
    // contradict the reason the release was blocked.
    expect(
      describeAuthOriginFailure({ kind: "wrong", siteUrl: `${APP_ORIGIN}\n` }, APP_ORIGIN),
    ).toContain(`'${APP_ORIGIN}\n'`);
  });
});
