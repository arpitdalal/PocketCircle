import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LOCAL_APP_VERSION, resolveAppRelease, resolveAppVersion } from "./resolve-app-version.js";

const execFileAsync = promisify(execFile);

describe("resolveAppVersion", () => {
  it("uses the immutable release tag", () => {
    expect(resolveAppVersion({ APP_RELEASE_VERSION: "v0.1.0" })).toBe("v0.1.0");
  });

  it("labels local builds when no release tag is supplied", () => {
    expect(resolveAppVersion({})).toBe("local-dev");
    expect(resolveAppVersion({ APP_RELEASE_VERSION: "   " })).toBe("local-dev");
    expect(LOCAL_APP_VERSION).toBe("local-dev");
  });

  it("keeps the full SHA as telemetry provenance", () => {
    expect(
      resolveAppRelease({
        APP_RELEASE_VERSION: " v0.1.0 ",
        APP_RELEASE_SHA: " a1b2c3d4e5f6789012345678901234567890abcd ",
      }),
    ).toBe("v0.1.0+a1b2c3d4e5f6789012345678901234567890abcd");
    expect(resolveAppRelease({ APP_RELEASE_VERSION: "v0.1.0" })).toBe("v0.1.0");
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

  it("deploys only verified immutable SemVer release tags", () => {
    const deploy = readFileSync(
      join(import.meta.dirname, "../../.github/workflows/deploy.yml"),
      "utf8",
    );
    expect(deploy).toContain("tags: [v*]");
    expect(deploy).toContain("uses: ./.github/workflows/e2e.yml");
    expect(deploy).toContain("APP_RELEASE_VERSION: $" + "{{ steps.release.outputs.version }}");
    expect(deploy).toContain("APP_RELEASE_SHA: $" + "{{ steps.release.outputs.sha }}");
    expect(deploy).toContain("run: ./scripts/release-notes.sh");
    expect(deploy).toContain("release:");
    expect(deploy).toContain("needs: deploy");
    expect(deploy).toContain("contents: write");
    expect(deploy).toContain("gh release create");
    expect(deploy).toContain("gh release edit");
    expect(deploy).toContain("--notes-file release-notes.md");
    expect(deploy).toContain("--draft=false");
    expect(deploy).toMatch(
      /published with notes that differ from CHANGELOG\.md\. Refusing to overwrite/,
    );
    expect(deploy).not.toContain("treating this retry as complete");
    expect(deploy).not.toContain("workflow_run:");
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

describe("release-notes.sh", () => {
  const script = join(import.meta.dirname, "../../scripts/release-notes.sh");

  async function extractNotes(changelog: string, version: string) {
    const dir = await mkdtemp(join(tmpdir(), "release-notes-"));
    await writeFile(join(dir, "CHANGELOG.md"), changelog);
    try {
      return await execFileAsync(script, [version], { cwd: dir });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("requires a bullet or paragraph, not only category headings", async () => {
    await expect(
      extractNotes(
        `# Changelog\n\n## [v0.1.0] - 2026-08-14\n\n### Added\n\n## [Unreleased]\n`,
        "v0.1.0",
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/bullet or paragraph/),
    });
  });

  it.each([
    ["HTML comment", "<!-- internal -->"],
    ["thematic break", "---"],
    ["spaced thematic break", "- - -"],
    ["spaced asterisk break", "* * *"],
    ["spaced underscore break", "_ _ _"],
    ["empty ATX heading", "###"],
    ["empty list marker", "-"],
  ])("rejects %s-only sections", async (_label, filler) => {
    await expect(
      extractNotes(`# Changelog\n\n## [v0.1.0] - 2026-08-14\n\n### Added\n\n${filler}\n`, "v0.1.0"),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/bullet or paragraph/),
    });
  });

  it("emits the dated section body when it has substantive notes", async () => {
    const { stdout } = await extractNotes(
      `# Changelog\n\n## [v0.1.0] - 2026-08-14\n\n### Added\n\n- Ship release notes from CHANGELOG.md\n`,
      "v0.1.0",
    );
    expect(stdout).toContain("### Added");
    expect(stdout).toContain("- Ship release notes from CHANGELOG.md");
  });
});
