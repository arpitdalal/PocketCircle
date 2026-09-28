#!/usr/bin/env node
/**
 * The deploy's origin gate, as a program rather than a shell fragment.
 *
 * Fails a release whose Convex production deployment does not have `SITE_URL` set to the
 * origin the product Worker claims — the one configuration where the app loads on a host
 * and sign-in fails in the browser with nothing to show for it.
 *
 * The decision is {@link classifyAuthOrigin}'s, in `packages/domain`, where it is unit
 * tested; this file only reads the variable and prints. It was a `run:` block of inline
 * shell until four review rounds found four byte-level bugs in it, none of which any test
 * could have caught because no test executed a workflow. `APP_ORIGIN` is imported from the
 * canonical origins module rather than read from the environment, so the value this gate
 * checks against cannot drift from the value the backend and the deploy workflow use
 * (`canonical-origins.test.ts` separately holds the workflow's own `APP_ORIGIN` to it).
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyAuthOrigin,
  describeAuthOriginFailure,
} from "../packages/domain/src/auth-origin.ts";
import { APP_ORIGIN } from "../packages/domain/src/origins.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const read = spawnSync(
  "pnpm",
  ["--filter", "@pocketcircle/convex", "exec", "convex", "env", "get", "SITE_URL"],
  { cwd: root, encoding: "utf8" },
);

const verdict = classifyAuthOrigin(
  { stdout: read.stdout ?? "", stderr: read.stderr ?? "", status: read.status ?? 1 },
  APP_ORIGIN,
);

const failure = describeAuthOriginFailure(verdict, APP_ORIGIN);
if (failure !== undefined) {
  console.error(`::error::${failure}`);
  process.exit(1);
}
console.log(`auth trusts ${APP_ORIGIN}, which the product Worker claims.`);
