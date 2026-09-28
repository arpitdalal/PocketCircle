/**
 * Deciding whether a Convex deployment's configured `SITE_URL` is the origin the
 * product Worker claims — the question the deploy's configuration check asks before it
 * lets a release ship.
 *
 * This is deliberately a *pure* function of the CLI's three outputs, with no process
 * spawning and no I/O, because the alternative is what this replaced: the same decision
 * inlined in a GitHub Actions `run:` block, where nothing can execute it. Four review
 * rounds found four bugs in that shell, every one of them a byte the gate treated
 * differently from the backend that consumes the value. Putting the bytes here means the
 * matrix is a unit test rather than a thing a reviewer has to reason about inside YAML.
 *
 * The rule the backend applies to the same variable lives in
 * {@link isDeclaredOrigin} next door, in `origins.ts`, and `auth-origin.test.ts` asserts
 * this module and that predicate accept exactly the same values — so the gate cannot be
 * looser than the parser. It is a test rather than a shared call because this module is
 * loaded by plain Node, which resolves a directly-named `.ts` file but not the
 * `.js`-for-`.ts` specifier every other module in the package uses, and importing with a
 * `.ts` extension is not enabled in `tsconfig.base.json`.
 *
 * The three outcomes a caller has to tell apart, because two of them are the same
 * symptom with opposite fixes:
 *
 *   - `unreachable` — the CLI failed for a reason that is not "not found", so the value
 *     is unknown. Reading that as a wrong value sends someone to fix a variable that is
 *     probably fine.
 *   - `unset` — no value at all. The backend falls back to the local dev origin, so it
 *     trusts nothing a User can reach.
 *   - `wrong` — set, and names a host the product Worker does not serve.
 *
 * The `./auth-origin` subpath export exists for the same reason `./origins` does: this is
 * loaded by `scripts/check-auth-origin.mjs` under plain Node, which cannot resolve the
 * package's own `.js`-for-`.ts` specifiers.
 */

/** What `convex env get` hands back: the bytes it printed, and how it exited. */
export interface ConvexEnvRead {
  /** Everything the CLI wrote to stdout, byte for byte. */
  readonly stdout: string;
  /** Everything it wrote to stderr. Never merged into the value. */
  readonly stderr: string;
  /** Its exit code. `convex env get` exits 0 for a variable that is not set. */
  readonly status: number;
}

export type AuthOriginVerdict =
  | { readonly kind: "ok"; readonly siteUrl: string }
  | { readonly kind: "unset" }
  | { readonly kind: "wrong"; readonly siteUrl: string }
  | { readonly kind: "unreachable"; readonly status: number; readonly detail: string };

/**
 * The one trailing newline the CLI prints after a value — and only that one.
 *
 * `convex env get` writes the stored value followed by `\n`. Everything the deployment
 * stores beyond that is part of the value, so nothing else may be removed: the backend
 * refuses a stored value carrying a trailing newline, and a gate that "tidied" the read
 * would approve exactly the value that takes sign-in down. `command substitution` is
 * worse rather than better here, because it strips *every* trailing newline and so hides
 * that byte along with the CLI's.
 */
const CLI_TRAILING_NEWLINE = "\n";

/** Whether the CLI reported the variable as absent, which it does on stderr. */
function reportsNotFound(stderr: string) {
  return /not found/i.test(stderr);
}

/**
 * The stored value, with the CLI's own delimiter removed and nothing else.
 *
 * Exported for the tests that assert the exact bytes; the verdict below is the API.
 */
export function readDeclaredOrigin({ stdout }: ConvexEnvRead) {
  return stdout.endsWith(CLI_TRAILING_NEWLINE)
    ? stdout.slice(0, -CLI_TRAILING_NEWLINE.length)
    : stdout;
}

/**
 * Classify a read of `SITE_URL` against the origin the product Worker claims.
 *
 * `expected` is the origin that must be configured — the product Worker's `APP_ORIGIN`.
 * A value that equals it passes. A value that does not is reported with what it actually
 * was, never with what it was trimmed to.
 */
export function classifyAuthOrigin(read: ConvexEnvRead, expected: string): AuthOriginVerdict {
  const siteUrl = readDeclaredOrigin(read);

  // Empty stdout with a non-zero exit that does not say "not found" is a transport or
  // auth failure, and is the one outcome that carries no information about the value.
  if (siteUrl === "" && read.status !== 0 && !reportsNotFound(read.stderr)) {
    return { kind: "unreachable", status: read.status, detail: read.stderr.trim() };
  }
  if (siteUrl === "") {
    return { kind: "unset" };
  }
  if (siteUrl !== expected) {
    return { kind: "wrong", siteUrl };
  }
  return { kind: "ok", siteUrl };
}

/** One line naming what is wrong and what to do, for a `::error::` annotation. */
export function describeAuthOriginFailure(verdict: AuthOriginVerdict, expected: string) {
  switch (verdict.kind) {
    case "ok":
      return undefined;
    case "unreachable":
      return `could not read SITE_URL from the Convex production deployment (status=${verdict.status}), so whether auth trusts ${expected} is unknown and this check will not guess: ${verdict.detail}`;
    case "unset":
      return `SITE_URL is not set on the Convex production deployment, so auth falls back to the local dev origin and trusts no origin a User can reach, while the product Worker claims ${expected}. Set it: convex env set --prod SITE_URL ${expected}`;
    case "wrong":
      return `auth does not trust ${expected}, and the product Worker claims it: SITE_URL is '${verdict.siteUrl}' — see README, origin migration`;
  }
}
