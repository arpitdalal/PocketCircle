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
 *   - `unreachable` — the command failed, so the value is unknown. Reading that as a wrong
 *     value sends someone to fix a variable that is probably fine. `convex env get`
 *     exits 0 for a variable that is not set, so *every* non-zero status is a genuine
 *     failure and none of them is a legitimate answer.
 *   - `unset` — no value at all. The backend falls back to the local dev origin, so it
 *     trusts nothing a User can reach.
 *   - `wrong` — set, and names a host the product Worker does not serve.
 *
 * The `./auth-origin` subpath export does **not** exist, and adding one was a mistake
 * worth recording: `scripts/check-auth-origin.mjs` imports this file by relative path, so
 * the export had no consumer. It would also have been the wrong shape — a subpath exists
 * so a *bundler-independent* tool can load a module whose internal `.js`-for-`.ts`
 * specifiers Node cannot follow, and this module has no imports at all, so plain Node
 * resolves it directly.
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

/**
 * The stored value, with the CLI's own delimiter removed and nothing else.
 *
 * Not exported: the verdict is the whole API, and it reports the value it read verbatim
 * in its `wrong` arm — so a caller, and the tests, can see the exact bytes without a
 * second entry point that exists only to be looked at.
 */
function readDeclaredOrigin({ stdout }: ConvexEnvRead) {
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
 *
 * The return type is annotated where the rest of this module infers, and deliberately:
 * it is a four-arm discriminated union that {@link describeAuthOriginFailure} narrows on,
 * so without the annotation TypeScript widens each returned literal to `{ kind: string }`
 * and none of the arms stay reachable at the call site.
 */
export function classifyAuthOrigin(read: ConvexEnvRead, expected: string): AuthOriginVerdict {
  // A non-zero exit is a failed read, whatever it managed to print. `convex env get`
  // exits 0 for a variable that is not set, so there is no legitimate non-zero status
  // here at all — which means this does not need to tell "not found" from a transport
  // failure, and must not try. It also must not be narrowed to "non-zero *and* empty
  // stdout": an interrupted command can flush the value and then fail, and a gate that
  // accepts a failed probe because the bytes it managed to emit look right is not a gate.
  if (read.status !== 0) {
    return { kind: "unreachable", status: read.status, detail: read.stderr.trim() };
  }

  const siteUrl = readDeclaredOrigin(read);
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
