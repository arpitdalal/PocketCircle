import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_APP_VERSION, resolveAppVersion } from "./resolve-app-version.js";

describe("resolveAppVersion", () => {
  it("uses a short SHA from the checked-out deployment revision", () => {
    expect(resolveAppVersion({ APP_RELEASE_SHA: "a1b2c3d4e5f6789012345678901234567890abcd" })).toBe(
      "a1b2c3d",
    );
  });

  it("labels local builds when no deployment SHA is supplied", () => {
    expect(resolveAppVersion({})).toBe("local-dev");
    expect(resolveAppVersion({ APP_RELEASE_SHA: "   " })).toBe("local-dev");
    expect(LOCAL_APP_VERSION).toBe("local-dev");
  });

  it("trims whitespace around a supplied SHA", () => {
    expect(resolveAppVersion({ APP_RELEASE_SHA: "  abcdef1zzzz  " })).toBe("abcdef1");
  });
});

describe("Vite version injection", () => {
  it("centralizes version resolution in the Vite and Vitest configs", () => {
    const dir = import.meta.dirname;
    const viteConfig = readFileSync(join(dir, "vite.config.ts"), "utf8");
    const vitestConfig = readFileSync(join(dir, "vitest.config.ts"), "utf8");

    expect(viteConfig).toMatch(/from\s+["']\.\/resolve-app-version/);
    expect(viteConfig).toMatch(/resolveAppVersion\(/);
    expect(viteConfig).not.toMatch(/npm_package_version/);
    expect(vitestConfig).toMatch(/from\s+["']\.\/resolve-app-version/);
    expect(vitestConfig).toMatch(/resolveAppVersion\(/);
    expect(vitestConfig).not.toMatch(/npm_package_version/);
  });

  it("injects the workflow_run head SHA into the production web build", () => {
    const deploy = readFileSync(
      join(import.meta.dirname, "../../.github/workflows/deploy.yml"),
      "utf8",
    );
    expect(deploy).toMatch(
      /APP_RELEASE_SHA:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/,
    );
    expect(deploy).not.toMatch(/APP_RELEASE_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
  });

  it("syncs Convex release and Sentry env only after a successful backend deploy", () => {
    const deploy = readFileSync(
      join(import.meta.dirname, "../../.github/workflows/deploy.yml"),
      "utf8",
    );
    const backendDeploy = deploy.indexOf("convex deploy -y");
    const setRelease = deploy.indexOf("convex env set APP_RELEASE");
    expect(backendDeploy).toBeGreaterThan(-1);
    expect(setRelease).toBeGreaterThan(backendDeploy);
    expect(deploy).toMatch(/convex env set SENTRY_DSN "\$VITE_SENTRY_DSN"/);
    expect(deploy).toMatch(/convex env remove SENTRY_DSN/);
  });
});
